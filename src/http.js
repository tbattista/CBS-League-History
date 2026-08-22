import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Polite, resilient HTTP for a site we do not control.
 *
 * Two things matter more than speed here:
 *   - Not hammering CBS. This is someone's league history, not a load test, and
 *     a 14-season crawl is only a few hundred requests. One per second is fine.
 *   - Never silently archiving a login page as if it were data. An expired
 *     cookie returns a perfectly valid 200 that happens to contain nothing we
 *     want, and quietly writing hundreds of those would look like success.
 */

const DEFAULT_DELAY_MS = 1000;
const MAX_RETRIES = 4;

export class Fetcher {
  constructor({ cookie, userAgent, delayMs = DEFAULT_DELAY_MS }) {
    this.cookie = cookie;
    this.userAgent = userAgent;
    this.delayMs = delayMs;
    this.lastRequestAt = 0;
    this.requestCount = 0;
  }

  async throttle() {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.delayMs) await sleep(this.delayMs - elapsed);
    this.lastRequestAt = Date.now();
  }

  /**
   * Fetch one page. Resolves to a result object rather than throwing on HTTP
   * errors -- the crawler wants to record failures in the manifest and keep
   * going, not abort a 300-page run over one dead link.
   */
  async get(url) {
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // 2s, 4s, 8s, 16s
        await sleep(1000 * 2 ** attempt);
      }
      await this.throttle();

      try {
        const response = await fetch(url, {
          redirect: 'follow',
          headers: {
            cookie: this.cookie,
            'user-agent': this.userAgent,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
          },
        });

        this.requestCount++;
        const body = await response.text();

        // Retry transient server-side failures; 4xx are our problem, not theirs.
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          lastError = `HTTP ${response.status}`;
          continue;
        }

        return {
          url,
          finalUrl: response.url || url,
          status: response.status,
          ok: response.ok,
          body,
          isLoginWall: looksLikeLogin(response.url || url, body),
        };
      } catch (error) {
        lastError = error.message;
        if (attempt === MAX_RETRIES) break;
      }
    }

    return {
      url,
      finalUrl: url,
      status: 0,
      ok: false,
      body: '',
      isLoginWall: false,
      error: lastError ?? 'unknown network error',
    };
  }
}

/**
 * Detect the "your cookie expired" case.
 *
 * Anonymous requests to a league page 302 to www.cbssports.com/login, which is
 * the clearest signal. We also sniff the body, because a soft login wall that
 * returns 200 in place would otherwise sail straight through.
 */
export function looksLikeLogin(finalUrl, body) {
  try {
    const { hostname, pathname } = new URL(finalUrl);
    if (hostname.endsWith('cbssports.com') && pathname.startsWith('/login')) return true;
  } catch {
    /* fall through to body sniffing */
  }

  if (!body) return false;
  const head = body.slice(0, 4000).toLowerCase();
  return (
    head.includes('name="password"') &&
    (head.includes('sign in') || head.includes('log in') || head.includes('login'))
  );
}
