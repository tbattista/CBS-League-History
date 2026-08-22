import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Link-driven crawler.
 *
 * The obvious approach would be to hardcode CBS's history URLs and loop over
 * seasons. We deliberately don't: CBS's paths have shifted over the years, and
 * a 14-season league almost certainly spans more than one generation of their
 * URL scheme. Guessed URLs would silently miss whole seasons, which is the one
 * failure mode that matters -- a backup with a hole in it looks complete.
 *
 * Instead we start from a few seeds and follow the league's own navigation.
 * Whatever CBS links to is, by definition, the real structure.
 */

const SEED_PATHS = ['/', '/history', '/history/standings', '/standings', '/draft'];

/** Paths worth following. Broad on purpose -- easier to filter noise later than to re-crawl. */
const RELEVANT = [
  'history', 'standings', 'draft', 'playoff', 'postseason', 'champion',
  'schedule', 'results', 'scoring', 'matchup', 'transaction', 'record',
  'season', 'archive', 'stats', 'team', 'owner', 'trade', 'keeper',
];

/** Never follow. Logout would end the session mid-crawl, which is worth being careful about. */
const FORBIDDEN = [
  'logout', 'signout', 'login', 'signin', 'register', 'subscribe', 'help',
  'support', 'privacy', 'terms', 'advertise', 'feedback', 'print',
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com',
];

export function normalizeUrl(input, base) {
  let url;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  url.hash = '';
  return url.toString();
}

export function shouldFollow(urlString, leagueOrigin) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  // Stay inside the league subdomain. CBS's main site is a different product
  // with a near-infinite crawl surface.
  if (url.origin !== leagueOrigin) return false;

  const haystack = `${url.pathname}${url.search}`.toLowerCase();
  if (FORBIDDEN.some((term) => haystack.includes(term))) return false;
  if (url.pathname === '/' ) return true;
  return RELEVANT.some((term) => haystack.includes(term));
}

/** Stable, readable, collision-free filename for a URL. */
export function fileNameFor(urlString) {
  const url = new URL(urlString);
  const slug =
    `${url.pathname}${url.search}`
      .replace(/^\/+/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120) || 'index';
  const digest = createHash('sha1').update(urlString).digest('hex').slice(0, 8);
  return `${slug}__${digest}.html`;
}

export function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const found = new Set();
  $('a[href]').each((_, el) => {
    const normalized = normalizeUrl($(el).attr('href'), baseUrl);
    if (normalized) found.add(normalized);
  });
  return [...found];
}

function loadManifest(path) {
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Breadth-first crawl, snapshotting every page to disk as it goes.
 *
 * Writes incrementally rather than at the end: a run that dies on page 200
 * should leave 199 pages of real backup behind, not nothing.
 */
export async function crawl({
  fetcher,
  leagueOrigin,
  outDir,
  maxPages = 500,
  force = false,
  onProgress = () => {},
}) {
  const rawDir = join(outDir, 'raw');
  const manifestPath = join(outDir, 'manifest.json');
  mkdirSync(rawDir, { recursive: true });

  const previous = force ? [] : loadManifest(manifestPath);
  const manifest = [...previous];
  const done = new Set(previous.filter((e) => e.ok).map((e) => e.url));

  const queue = SEED_PATHS.map((p) => normalizeUrl(p, leagueOrigin)).filter(Boolean);
  const queued = new Set(queue);

  let loginWallHits = 0;

  while (queue.length > 0 && manifest.length < maxPages) {
    const url = queue.shift();
    if (done.has(url)) continue;

    const result = await fetcher.get(url);
    done.add(url);

    if (result.isLoginWall) {
      loginWallHits++;
      // One redirect could be a stray unauthenticated path. Several in a row
      // means the cookie is dead, and continuing would just archive login pages.
      if (loginWallHits >= 3) {
        throw new Error(
          'Session rejected: CBS redirected us to the login page repeatedly.\n' +
            'The cookie in curl.txt has almost certainly expired. Re-copy it ' +
            'from a freshly loaded league page and run again.',
        );
      }
    } else if (result.ok) {
      loginWallHits = 0;
    }

    const entry = {
      url,
      finalUrl: result.finalUrl,
      status: result.status,
      ok: result.ok && !result.isLoginWall,
      isLoginWall: result.isLoginWall,
      bytes: result.body.length,
      fetchedAt: new Date().toISOString(),
      file: null,
      error: result.error ?? null,
    };

    if (entry.ok && result.body) {
      const fileName = fileNameFor(url);
      const filePath = join(rawDir, fileName);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, result.body, 'utf8');
      entry.file = join('raw', fileName);

      for (const link of extractLinks(result.body, url)) {
        if (!queued.has(link) && !done.has(link) && shouldFollow(link, leagueOrigin)) {
          queued.add(link);
          queue.push(link);
        }
      }
    }

    manifest.push(entry);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    onProgress(entry, { done: manifest.length, pending: queue.length });
  }

  return {
    manifest,
    manifestPath,
    truncated: queue.length > 0,
    remaining: queue.length,
  };
}

export function outputDir(cwd = process.cwd()) {
  return resolve(cwd, 'data');
}
