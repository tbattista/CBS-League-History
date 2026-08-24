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

const SEED_PATHS = [
  '/',
  '/history',
  '/history/year-by-year',
  '/history/standings',
  '/history/record-book',
  '/history/team-overview',
  '/standings',
  '/draft/results',
  '/transactions',
];

/** Paths worth following. Broad on purpose -- easier to filter noise later than to re-crawl. */
const RELEVANT = [
  'history', 'standings', 'draft', 'playoff', 'postseason', 'champion',
  'schedule', 'results', 'scoring', 'matchup', 'transaction', 'record',
  'season', 'archive', 'team', 'owner', 'trade', 'keeper', 'award',
];

/** Never follow. Logout would end the session mid-crawl, which is worth being careful about. */
const FORBIDDEN = [
  'logout', 'signout', 'login', 'signin', 'register', 'subscribe', 'help',
  'support', 'privacy', 'terms', 'advertise', 'feedback', 'print',
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com',
];

/**
 * Whole sections that are not league history.
 *
 * A first full run against a real 15-season league spent 92 of its 500 pages
 * on these: CBS's own editorial and draft-prep content, current-season player
 * stat screens, and commissioner settings forms. They are linked from league
 * navigation, so a link-following crawler walks straight into them, and the
 * budget they consume comes straight out of the seasons we came for.
 *
 * /setup/ is excluded for a second reason: those pages administer the league
 * (add year, remove years, manage teams). We only ever issue GETs, but there is
 * no reason to have the archiver anywhere near them.
 */
const EXCLUDED_SECTIONS = [
  '/news/', '/draft-central', '/mockdraft', '/setup/', '/stats',
  '/scoring/live', '/roster-report', '/scout-team', '/trade-block',
  '/content/', '/advice',
];

/**
 * Query parameters that re-render a page without changing what it says.
 *
 * CBS puts sort links on every table, and each one is a distinct URL serving
 * identical data. On the first real run these produced 178 of 500 pages --
 * 32 copies of one year-by-year page alone. Stripping them collapses each
 * table back to a single canonical fetch.
 *
 * The names are prefixed per-table (leagueRecordsTable:sort_col, and so on),
 * so match on the suffix rather than the whole name.
 */
const VOLATILE_PARAMS = /(^|:)(sort_col|sort_dir|start_row|presentation|action|want_deleted|default_add)$/i;

export function normalizeUrl(input, base) {
  let url;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  url.hash = '';

  for (const name of [...url.searchParams.keys()]) {
    if (VOLATILE_PARAMS.test(name)) url.searchParams.delete(name);
  }
  // Keep the canonical form stable: "?" alone and "?a=1" must not both appear.
  url.search = url.searchParams.toString();

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
  if (EXCLUDED_SECTIONS.some((term) => haystack.includes(term))) return false;
  if (url.pathname === '/') return true;
  return RELEVANT.some((term) => haystack.includes(term));
}

/** Draft variants CBS exposes per season. "Official" is usually the real one. */
const DRAFT_LABELS = ['Official', 'Pre-season', 'Season'];

/**
 * Per-season pages, keyed directly by year.
 *
 * Confirmed against a real league rather than guessed. These exist for every
 * season whether or not the league's navigation still links to them -- older
 * seasons in particular are reachable by URL but buried or absent in the nav,
 * which is exactly how the first run ended up with 2021-2025 standings and
 * nothing before that.
 */
export const SEASON_URL_PATTERNS = [
  (year) => `/history/year-by-year/${year}`,
  (year) => `/history/standings/${year}`,
  (year) => `/history/champion/${year}`,
  (year) => `/history/awards/${year}`,
  (year) => `/history/team-overview/${year}`,
  // Each season has several drafts, not one. A league's draft-results page
  // exposes them through a dropdown reading "2025 - Official", "2025 - 3",
  // "2025 - Pre-season" and so on, and the URL carries that label. The first
  // real run only ever hit Pre-season, which for most seasons is an abandoned
  // mock -- the actual draft is usually Official. Try the plausible labels and
  // let the coverage grid show which ones came back with data.
  ...DRAFT_LABELS.map((label) => (year) => `/draft/results/${year}:${label}:${label}`),
  (year) => `/draft/results/${year}`,
];

/**
 * Does this page actually contain data, as opposed to just returning 200?
 *
 * CBS serves a normal-looking page for *any* year in a season URL, including
 * ones the league never played. /history/standings/1996 answers 200 with full
 * site chrome and no data table at all. Status alone cannot tell a real season
 * from a fabricated one.
 */
export function hasDataTable(html) {
  const $ = cheerio.load(html);
  let found = false;
  $('table').each((_, el) => {
    if (found) return;
    if ($(el).find('tr').length > 2) found = true;
  });
  return found;
}

/**
 * Years the crawl has evidence for.
 *
 * Evidence means a page that came back with data, not merely one that came back.
 * Counting bare 200s here is what let an earlier version walk the backfill out
 * to 1996-2041 for a league that started in 2012: every probe "succeeded", so
 * the range never stopped expanding.
 *
 * Entries predating the hasData field are counted, so resuming an older
 * manifest still behaves as it did before.
 */
export function discoverSeasons(manifest) {
  const years = new Set();
  for (const entry of manifest) {
    if (!entry.ok || entry.hasData === false) continue;
    // Only year-by-year and standings are trusted as proof a season happened.
    // Champion and awards pages render a fixed template table -- every award
    // slot the league has ever defined -- so they come back looking populated
    // for 1996 as readily as for 2015, and cannot distinguish the two.
    const match = entry.url.match(/\/history\/(?:year-by-year|standings)\/(\d{4})/);
    if (match) years.add(Number(match[1]));
  }
  return [...years].sort((a, b) => a - b);
}

/** Sanity bounds, so a probing bug can never run away again. */
const EARLIEST_PLAUSIBLE_SEASON = 1990;
const LATEST_PLAUSIBLE_SEASON = new Date().getFullYear() + 1;

/**
 * Fill in the seasons the link graph does not reach.
 *
 * Once any season page is found we know the URL shape, and seasons are just
 * integers -- so the full span can be enumerated directly instead of hoping
 * CBS still links to 2012. The span is extended one year past the oldest and
 * newest seen, to catch a boundary season that nothing links to.
 */
export function seasonBackfillUrls(manifest, leagueOrigin, padding = 2) {
  const seasons = discoverSeasons(manifest);
  if (seasons.length === 0) return [];

  const first = Math.max(seasons[0] - padding, EARLIEST_PLAUSIBLE_SEASON);
  const last = Math.min(seasons[seasons.length - 1] + padding, LATEST_PLAUSIBLE_SEASON);

  const urls = [];
  for (let year = first; year <= last; year++) {
    for (const pattern of SEASON_URL_PATTERNS) {
      const url = normalizeUrl(pattern(year), leagueOrigin);
      if (url) urls.push(url);
    }
  }
  return urls;
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
  maxPages = 1500,
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

  /**
   * Drain the queue, optionally following links out of each page.
   *
   * The backfill pass sets followLinks false: those URLs are already known to
   * be the ones we want, and re-harvesting their links would just re-enqueue
   * the same navigation the first pass already walked.
   */
  async function drain({ followLinks, phase }) {
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
        phase,
        error: result.error ?? null,
      };

      if (entry.ok && result.body) {
        const fileName = fileNameFor(url);
        const filePath = join(rawDir, fileName);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, result.body, 'utf8');
        entry.file = join('raw', fileName);
        entry.hasData = hasDataTable(result.body);

        if (followLinks) {
          for (const link of extractLinks(result.body, url)) {
            if (!queued.has(link) && !done.has(link) && shouldFollow(link, leagueOrigin)) {
              queued.add(link);
              queue.push(link);
            }
          }
        }
      }

      manifest.push(entry);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      onProgress(entry, { done: manifest.length, pending: queue.length, phase });
    }
  }

  await drain({ followLinks: true, phase: 'crawl' });

  // Second pass: seasons the navigation never linked to. Older seasons drop out
  // of the nav over time, so following links alone reliably misses them.
  //
  // Repeat until a round finds nothing new. Each round re-derives the span from
  // everything archived so far, so discovering an older season automatically
  // reaches further back on the next round -- the range walks outward on its
  // own instead of being guessed up front.
  let backfillCount = 0;
  for (let round = 0; round < 8; round++) {
    const backfill = seasonBackfillUrls(manifest, leagueOrigin).filter(
      (url) => !done.has(url) && !queued.has(url),
    );
    if (backfill.length === 0) break;

    backfillCount += backfill.length;
    for (const url of backfill) {
      queued.add(url);
      queue.push(url);
    }
    await drain({ followLinks: false, phase: 'backfill' });
    if (manifest.length >= maxPages) break;
  }

  return {
    manifest,
    manifestPath,
    seasons: discoverSeasons(manifest),
    backfillAttempted: backfillCount,
    truncated: queue.length > 0,
    remaining: queue.length,
  };
}

export function outputDir(cwd = process.cwd()) {
  return resolve(cwd, 'data');
}
