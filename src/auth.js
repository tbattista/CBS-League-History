import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Auth for CBS fantasy pages is a plain session cookie -- the history pages are
 * server-rendered HTML behind a cookie check, not a JS app. So all we need is a
 * valid Cookie header.
 *
 * Two ways to supply it, in priority order:
 *
 *   1. curl.txt  -- paste the output of Chrome DevTools "Copy as cURL" here.
 *                   This is the low-effort path: it carries the cookies, the
 *                   user-agent and the league URL all at once, so there is
 *                   nothing to hand-assemble and nothing to typo.
 *   2. CBS_COOKIE / CBS_LEAGUE_URL env vars -- better for Railway or CI, where
 *                   pasting a curl blob into a file is awkward.
 *
 * Both are gitignored. Nothing here should ever reach the repo.
 */

const CURL_FILE = 'curl.txt';

/** Chrome quotes with ' on macOS/Linux and " on Windows. Handle both. */
function extractQuoted(source, pattern) {
  const match = source.match(pattern);
  return match ? match[2] : null;
}

/**
 * Pull cookie, URL and headers out of a "Copy as cURL" blob.
 *
 * We deliberately parse loosely rather than fully tokenizing the shell command:
 * Chrome's exact quoting varies by platform and version, and we only need three
 * things out of it.
 */
export function parseCurl(text) {
  const cookieHeader =
    extractQuoted(text, /-H\s+(['"])cookie:\s*([\s\S]*?)\1/i) ??
    extractQuoted(text, /(?:^|\s)-b\s+(['"])([\s\S]*?)\1/);

  const userAgent = extractQuoted(text, /-H\s+(['"])user-agent:\s*([\s\S]*?)\1/i);

  // The request URL is the first quoted http(s) argument.
  const urlMatch = text.match(/(['"])(https?:\/\/[^'"]+)\1/);
  const url = urlMatch ? urlMatch[2] : null;

  return {
    cookie: cookieHeader ? cookieHeader.trim() : null,
    userAgent: userAgent ? userAgent.trim() : null,
    url,
  };
}

/**
 * Resolve credentials + target league from whichever source is available.
 * Throws with an actionable message rather than failing deep inside a fetch.
 */
export function loadAuth({ cwd = process.cwd() } = {}) {
  const curlPath = resolve(cwd, CURL_FILE);

  let fromCurl = { cookie: null, userAgent: null, url: null };
  if (existsSync(curlPath)) {
    const raw = readFileSync(curlPath, 'utf8').trim();
    if (raw) fromCurl = parseCurl(raw);
  }

  const cookie = fromCurl.cookie || process.env.CBS_COOKIE || null;
  const leagueUrl = process.env.CBS_LEAGUE_URL || fromCurl.url || null;
  const userAgent =
    fromCurl.userAgent ||
    process.env.CBS_USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

  if (!cookie) {
    throw new Error(
      `No CBS session cookie found.\n\n` +
        `Do this:\n` +
        `  1. Open your league's history page in Chrome, logged in\n` +
        `  2. DevTools -> Network -> reload -> click the top document request\n` +
        `  3. Right-click -> Copy -> Copy as cURL\n` +
        `  4. Paste it into ${CURL_FILE} in this repo\n\n` +
        `(${CURL_FILE} is gitignored.) Or set CBS_COOKIE and CBS_LEAGUE_URL instead.`,
    );
  }

  if (!leagueUrl) {
    throw new Error(
      `Found a cookie but no league URL.\n` +
        `Set CBS_LEAGUE_URL (e.g. https://yourleague.football.cbssports.com/), ` +
        `or copy the cURL from a league page so the URL comes along with it.`,
    );
  }

  return { cookie, userAgent, leagueUrl: normalizeLeagueUrl(leagueUrl) };
}

/** Reduce any in-league URL down to its origin, e.g. https://x.football.cbssports.com */
export function normalizeLeagueUrl(input) {
  const url = new URL(input);
  return url.origin;
}

/**
 * A cookie is a live credential. When we echo config back to the terminal we
 * show only enough to confirm the right one loaded.
 */
export function redact(cookie) {
  if (!cookie) return '<none>';
  const names = cookie
    .split(';')
    .map((pair) => pair.split('=')[0].trim())
    .filter(Boolean);
  return `${names.length} cookies [${names.slice(0, 6).join(', ')}${names.length > 6 ? ', ...' : ''}]`;
}
