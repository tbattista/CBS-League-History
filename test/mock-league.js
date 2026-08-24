import { createServer } from 'node:http';

/**
 * A stand-in for a CBS fantasy league, used to exercise the crawler end to end
 * without touching the real site or needing a live session.
 *
 * It reproduces the behaviours that actually matter to us:
 *   - cookie-gated pages that 302 to a login page when unauthenticated
 *   - a history index that links out to per-season pages
 *   - season pages whose URLs are only discoverable by following links
 *   - real <table> markup for the structural report to chew on
 *   - some dead links, so failure handling gets tested too
 */

const SEASONS = [2012, 2013, 2014, 2015];
const TEAMS = [
  ['Gridiron Gurus', 'Dave', 11, 3, 1544.2],
  ['Sunday Scaries', 'Marcus', 9, 5, 1490.7],
  ['End Zone Militia', 'Tony', 8, 6, 1455.1],
  ['Waiver Wire Wolves', 'Priya', 4, 10, 1288.9],
];

const page = (title, body) => `<!doctype html>
<html><head><title>${title}</title></head>
<body><h1>${title}</h1>${body}</body></html>`;

const standingsTable = (season) => `
<table>
  <tr><th>Rank</th><th>Team</th><th>Owner</th><th>W</th><th>L</th><th>Points For</th></tr>
  ${TEAMS.map(
    ([team, owner, w, l, pf], i) =>
      `<tr><td>${i + 1}</td><td>${team}</td><td>${owner}</td><td>${w}</td><td>${l}</td><td>${pf}</td></tr>`,
  ).join('\n  ')}
</table>
<p>Final standings for the ${season} season.</p>`;

const draftTable = (season) => `
<table>
  <tr><th>Round</th><th>Pick</th><th>Team</th><th>Player</th><th>Position</th></tr>
  ${TEAMS.map(
    ([team], i) =>
      `<tr><td>1</td><td>${i + 1}</td><td>${team}</td><td>Player ${i + 1}</td><td>RB</td></tr>`,
  ).join('\n  ')}
</table>
<p>${season} draft results.</p>`;

const ROUTES = {
  '/': () =>
    page(
      'Mock Fantasy League',
      `<ul>
        <li><a href="/history">League History</a></li>
        <li><a href="/standings">Current Standings</a></li>
        <li><a href="/logout">Log Out</a></li>
        <li><a href="https://www.facebook.com/share">Share on Facebook</a></li>
      </ul>`,
    ),

  // Only the two most recent seasons are linked. The older ones exist but are
  // reachable by URL alone -- the same way a real league drops old seasons out
  // of its navigation, which is what defeats a purely link-following crawler.
  '/history': () =>
    page(
      'League History',
      `<ul>
        ${SEASONS.slice(-2)
          .map(
            (s) =>
              `<li><a href="/history/year-by-year/${s}">${s}</a> &middot;
               <a href="/history/standings?season=${s}">${s} Standings</a> &middot;
               <a href="/history/draft?season=${s}">${s} Draft</a></li>`,
          )
          .join('\n        ')}
      </ul>
      <p><a href="/history/champions">Champions</a></p>
      <p><a href="/history/missing-page">Broken Link</a></p>
      <!-- Sort links: same data, different order. Must collapse to one fetch. -->
      <p>
        <a href="/history?allTimeStandingsTable:sort_col=PF&allTimeStandingsTable:sort_dir=DESC">Sort by PF</a>
        <a href="/history?allTimeStandingsTable:sort_col=W&allTimeStandingsTable:sort_dir=ASC">Sort by W</a>
      </p>
      <!-- Editorial and admin sections: linked from league nav, not league history. -->
      <p>
        <a href="/news/2026-fantasy-football-draft-prep">Draft Prep</a>
        <a href="/draft-central/draft-research">Draft Research</a>
        <a href="/setup/commish-tools/manage-teams-managers">Manage Teams</a>
        <a href="/stats/stats-main">Player Stats</a>
      </p>`,
    ),

  '/history/champions': () =>
    page(
      'Champions',
      `<table>
        <tr><th>Season</th><th>Champion</th><th>Owner</th></tr>
        ${SEASONS.map(
          (s, i) =>
            `<tr><td>${s}</td><td>${TEAMS[i % TEAMS.length][0]}</td><td>${TEAMS[i % TEAMS.length][1]}</td></tr>`,
        ).join('\n        ')}
      </table>`,
    ),

  '/standings': () => page('Current Standings', standingsTable(2015)),
};

function resolveRoute(pathname, search) {
  if (ROUTES[pathname]) return ROUTES[pathname]();

  const season = new URLSearchParams(search).get('season');
  if (pathname === '/history/standings' && season) {
    return page(`${season} Standings`, standingsTable(season));
  }
  if (pathname === '/history/draft' && season) {
    return page(`${season} Draft Results`, draftTable(season));
  }

  // Path-keyed season pages, mirroring the real league's URL shape. These exist
  // for every season regardless of whether anything links to them.
  const pathSeason = pathname.match(
    /^\/history\/(year-by-year|standings|champion|awards)\/(\d{4})$/,
  );
  if (pathSeason) {
    const [, kind, year] = pathSeason;
    // CBS answers 200 for *any* year, including seasons the league never
    // played -- full page chrome, no data table. It never 404s here, so a
    // crawler that treats "fetched OK" as "season exists" will probe outward
    // forever. Reproduce that exactly.
    if (!SEASONS.includes(Number(year))) {
      return page(`${year} Season`, '<p>No data available for this season.</p>');
    }
    if (kind === 'champion') {
      return page(
        `${year} Champion`,
        `<table><tr><th>Season</th><th>Champion</th></tr>
         <tr><td>${year}</td><td>${TEAMS[0][0]}</td></tr></table>`,
      );
    }
    if (kind === 'awards') {
      return page(
        `${year} Awards`,
        `<table><tr><th>Award</th><th>Team</th></tr>
         <tr><td>Champion</td><td>${TEAMS[0][0]}</td></tr></table>`,
      );
    }
    return page(`${year} Standings`, standingsTable(year));
  }

  const draftSeason = pathname.match(/^\/draft\/results\/(\d{4})(?::|$)/);
  if (draftSeason) {
    const year = draftSeason[1];
    if (!SEASONS.includes(Number(year))) {
      return page(`${year} Draft`, '<p>No draft available.</p>');
    }
    return page(`${year} Draft Results`, draftTable(year));
  }

  return null;
}

export function startMockLeague({ requireCookie = 'mock_session=valid' } = {}) {
  const server = createServer((req, res) => {
    const { pathname, search } = new URL(req.url, 'http://localhost');

    if (pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        page('Sign In', '<form><input name="password" type="password"/><button>Log In</button></form>'),
      );
      return;
    }

    const authorized = (req.headers.cookie ?? '').includes(requireCookie);
    if (!authorized) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }

    const html = resolveRoute(pathname, search);
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(page('Not Found', '<p>No such page.</p>'));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}`, seasons: SEASONS });
    });
  });
}
