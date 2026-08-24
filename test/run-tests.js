import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startMockLeague } from './mock-league.js';
import { parseCurl, normalizeLeagueUrl, redact } from '../src/auth.js';
import { Fetcher, looksLikeLogin } from '../src/http.js';
import { crawl, shouldFollow, fileNameFor, extractLinks, normalizeUrl } from '../src/crawl.js';
import { buildReport } from '../src/report.js';

test('parseCurl handles Chrome copy-as-cURL on mac/linux', () => {
  const blob = `curl 'https://myleague.football.cbssports.com/history/standings' \\
  -H 'user-agent: Mozilla/5.0 (Macintosh) Chrome/141.0.0.0' \\
  -H 'cookie: pid=abc123; ubid=xyz789; anon=FALSE' \\
  --compressed`;
  const parsed = parseCurl(blob);
  assert.equal(parsed.cookie, 'pid=abc123; ubid=xyz789; anon=FALSE');
  assert.equal(parsed.url, 'https://myleague.football.cbssports.com/history/standings');
  assert.match(parsed.userAgent, /Chrome\/141/);
});

test('parseCurl handles Windows double-quoted form', () => {
  const blob = `curl "https://myleague.football.cbssports.com/history" ^
  -H "cookie: pid=win123; anon=FALSE"`;
  const parsed = parseCurl(blob);
  assert.equal(parsed.cookie, 'pid=win123; anon=FALSE');
  assert.equal(parsed.url, 'https://myleague.football.cbssports.com/history');
});

test('parseCurl repairs cmd-form percent escaping', () => {
  // Chrome's cmd form doubles every '%'. CBS cookies are full of percent
  // encoding, so a cmd copy is silently corrupt unless we undo this.
  const blob =
    `curl "https://myleague.football.cbssports.com/history" ^\r\n` +
    `  -H "cookie: pid=S%%3A1%%3AvrhEvVgtZOAhsrDWFZ2K%%252Fw%%253D%%253D%%3A1; anon=FALSE"`;
  const parsed = parseCurl(blob);
  assert.equal(parsed.cookie, 'pid=S%3A1%3AvrhEvVgtZOAhsrDWFZ2K%252Fw%253D%253D%3A1; anon=FALSE');
  assert.ok(!parsed.cookie.includes('%%'), 'cmd escaping left in place');
});

test('parseCurl leaves bash-form percent encoding untouched', () => {
  const blob =
    `curl 'https://myleague.football.cbssports.com/history' \\\n` +
    `  -H 'cookie: pid=S%3A1%3Aabc%253D%253D; anon=FALSE'`;
  const parsed = parseCurl(blob);
  assert.equal(parsed.cookie, 'pid=S%3A1%3Aabc%253D%253D; anon=FALSE');
});

test('parseCurl handles the -b cookie form', () => {
  const parsed = parseCurl(`curl 'https://x.football.cbssports.com/' -b 'pid=jar456'`);
  assert.equal(parsed.cookie, 'pid=jar456');
});

test('normalizeLeagueUrl reduces any in-league URL to its origin', () => {
  assert.equal(
    normalizeLeagueUrl('https://myleague.football.cbssports.com/history/standings?season=2014'),
    'https://myleague.football.cbssports.com',
  );
});

test('redact never leaks cookie values', () => {
  const output = redact('pid=SECRETVALUE; ubid=ANOTHERSECRET');
  assert.ok(!output.includes('SECRETVALUE'));
  assert.ok(!output.includes('ANOTHERSECRET'));
  assert.match(output, /2 cookies/);
});

test('looksLikeLogin catches the real CBS redirect target', () => {
  assert.ok(looksLikeLogin('https://www.cbssports.com/login?product_abbrev=mgmt', ''));
  assert.ok(!looksLikeLogin('https://x.football.cbssports.com/history', '<html>data</html>'));
});

test('looksLikeLogin catches a soft 200 login wall', () => {
  const html = '<html><body><h1>Sign In</h1><input name="password" type="password"></body></html>';
  assert.ok(looksLikeLogin('https://x.football.cbssports.com/history', html));
});

test('shouldFollow stays in-league and avoids destructive links', () => {
  const origin = 'https://myleague.football.cbssports.com';
  assert.ok(shouldFollow(`${origin}/history/standings?season=2011`, origin));
  assert.ok(shouldFollow(`${origin}/draft/results`, origin));
  // Logging out mid-crawl would kill the session.
  assert.ok(!shouldFollow(`${origin}/logout`, origin));
  // CBS proper is a different, effectively unbounded site.
  assert.ok(!shouldFollow('https://www.cbssports.com/nfl/news', origin));
  assert.ok(!shouldFollow('https://www.facebook.com/sharer', origin));
});

test('fileNameFor is readable, safe, and unique per query string', () => {
  const a = fileNameFor('https://x.football.cbssports.com/history/standings?season=2012');
  const b = fileNameFor('https://x.football.cbssports.com/history/standings?season=2013');
  assert.notEqual(a, b, 'different seasons must not collide');
  assert.match(a, /^history_standings_season_2012__[0-9a-f]{8}\.html$/);
  assert.ok(!/[^a-zA-Z0-9._-]/.test(a), 'filename must be filesystem-safe');
});

test('extractLinks resolves relative hrefs against the page URL', () => {
  const html = '<a href="/history">H</a><a href="draft?season=2014">D</a><a href="#top">skip</a>';
  const links = extractLinks(html, 'https://x.football.cbssports.com/league/');
  assert.ok(links.includes('https://x.football.cbssports.com/history'));
  assert.ok(links.includes('https://x.football.cbssports.com/league/draft?season=2014'));
});

test('normalizeUrl rejects javascript: and mailto: hrefs', () => {
  const base = 'https://x.football.cbssports.com/';
  assert.equal(normalizeUrl('javascript:void(0)', base), null);
  assert.equal(normalizeUrl('mailto:a@b.com', base), null);
});

// --- End-to-end against the mock league ------------------------------------

test('crawl discovers every season by following links, and reports on them', async (t) => {
  const { server, origin, seasons } = await startMockLeague();
  t.after(() => server.close());

  const outDir = mkdtempSync(join(tmpdir(), 'cbs-crawl-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const fetcher = new Fetcher({
    cookie: 'mock_session=valid',
    userAgent: 'test-agent',
    delayMs: 0,
  });

  const { manifest } = await crawl({ fetcher, leagueOrigin: origin, outDir, maxPages: 100 });

  const archived = manifest.filter((e) => e.ok);
  const archivedUrls = archived.map((e) => e.url);

  // The crawler was never told these URLs exist -- it had to find them.
  for (const season of seasons) {
    assert.ok(
      archivedUrls.some((u) => u.includes(`/history/standings?season=${season}`)),
      `missing ${season} standings`,
    );
    assert.ok(
      archivedUrls.some((u) => u.includes(`/history/draft?season=${season}`)),
      `missing ${season} draft`,
    );
  }
  assert.ok(archivedUrls.some((u) => u.endsWith('/history/champions')), 'missing champions page');

  // Excluded links must not have been fetched at all.
  assert.ok(!archivedUrls.some((u) => u.includes('/logout')), 'crawler followed logout');
  assert.ok(!archivedUrls.some((u) => u.includes('facebook')), 'crawler left the league site');

  // A dead link is recorded as a failure, not a crash.
  const broken = manifest.find((e) => e.url.includes('missing-page'));
  assert.ok(broken && !broken.ok && broken.status === 404, 'broken link not recorded as 404');

  // Every archived page actually hit disk.
  for (const entry of archived) {
    assert.ok(existsSync(join(outDir, entry.file)), `snapshot missing: ${entry.file}`);
  }

  // The structural report is what parser work gets written against.
  const { report } = buildReport(outDir);
  assert.equal(report.pagesArchived, archived.length);
  for (const season of seasons) {
    assert.ok(report.seasonsDetected.includes(String(season)), `report missed ${season}`);
  }

  const standings = report.pages.find((p) => p.url.includes('standings?season=2012'));
  assert.ok(standings, 'no 2012 standings page in report');
  assert.deepEqual(standings.tables[0].headers, [
    'Rank', 'Team', 'Owner', 'W', 'L', 'Points For',
  ]);
  assert.equal(standings.tables[0].rowCount, 5, 'header row + 4 teams');
});

test('crawl aborts loudly when the session cookie is dead', async (t) => {
  const { server, origin } = await startMockLeague();
  t.after(() => server.close());

  const outDir = mkdtempSync(join(tmpdir(), 'cbs-dead-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const fetcher = new Fetcher({ cookie: 'mock_session=EXPIRED', userAgent: 't', delayMs: 0 });

  // The whole point: an expired cookie must not quietly archive login pages.
  await assert.rejects(
    () => crawl({ fetcher, leagueOrigin: origin, outDir, maxPages: 100 }),
    /Session rejected/,
  );

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.every((e) => !e.ok), 'a login page was archived as real data');
});

test('crawl resumes without re-fetching what it already has', async (t) => {
  const { server, origin } = await startMockLeague();
  t.after(() => server.close());

  const outDir = mkdtempSync(join(tmpdir(), 'cbs-resume-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  const makeFetcher = () =>
    new Fetcher({ cookie: 'mock_session=valid', userAgent: 't', delayMs: 0 });

  const first = makeFetcher();
  await crawl({ fetcher: first, leagueOrigin: origin, outDir, maxPages: 4 });
  assert.ok(first.requestCount > 0);

  const second = makeFetcher();
  await crawl({ fetcher: second, leagueOrigin: origin, outDir, maxPages: 100 });

  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
  const urls = manifest.filter((e) => e.ok).map((e) => e.url);
  assert.equal(new Set(urls).size, urls.length, 'resumed run re-fetched pages it already had');
});
