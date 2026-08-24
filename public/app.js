/**
 * League history dashboard.
 *
 * Reads the committed dataset once and renders everything client-side. The data
 * never changes between deploys, so there is no server to talk to beyond the
 * single JSON fetch.
 *
 * Charts follow one rule worth stating: a table is the default form for this
 * data. Standings, drafts and head-to-head are identity plus many measures,
 * which a table shows exactly and a chart only approximates. Charts appear
 * where the question is genuinely shape-over-time or magnitude-ranking.
 */

const main = document.getElementById('main');
let DATA = null;
let byId = new Map();

const state = { view: 'overview', season: null, franchise: null, opponent: null, draftYear: null };

/**
 * Default to a franchise with real history rather than whoever tops a rate
 * stat. Franchises are sorted by win percentage, so the untouched default was
 * a two-season cameo with a hot streak -- an odd first impression of a
 * fourteen-year league.
 */
function defaultFranchiseId() {
  const ranked = DATA.franchises
    .slice()
    .sort((a, b) => b.seasons.length - a.seasons.length || b.championships.length - a.championships.length);
  return ranked[0]?.teamId ?? null;
}

// --- utilities --------------------------------------------------------------

const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) node.setAttribute(key, String(value));
  }
  return node;
};

const num = (value, places = 1) =>
  value == null ? '—' : Number(value).toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });

const int = (value) => (value == null ? '—' : Number(value).toLocaleString());
const pct = (value) => (value == null ? '—' : value.toFixed(3).replace(/^0/, ''));
const record = (t) => `${t.wins ?? 0}-${t.losses ?? 0}${t.ties ? `-${t.ties}` : ''}`;
const nameOf = (id) => byId.get(id)?.currentName ?? '—';

/** A franchise's name in a given season, which is often not its current one. */
function nameInSeason(id, year) {
  const f = byId.get(id);
  return f?.seasonStats.find((s) => s.year === year)?.name ?? f?.currentName ?? '—';
}

// --- charts -----------------------------------------------------------------

/**
 * Horizontal bars for ranked magnitude. Single series, so no legend: the panel
 * heading names the measure. Every bar is directly labeled rather than relying
 * on an axis readback, and the label is what carries the value -- the bar only
 * carries the comparison.
 */
function barChart(rows, { valueLabel = (r) => int(r.value), max = null } = {}) {
  if (!rows.length) return h('p', { class: 'empty' }, 'No data');

  const rowH = 28;
  const labelW = 190;
  const valueW = 54;
  const width = 720;
  const height = rows.length * rowH + 8;
  const limit = max ?? Math.max(...rows.map((r) => r.value), 1);
  const barMax = width - labelW - valueW - 16;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': `${rows.length} ranked bars`,
  });

  rows.forEach((row, i) => {
    const y = i * rowH + 4;
    const w = Math.max(2, (row.value / limit) * barMax);

    const label = svgEl('text', {
      x: labelW - 10,
      y: y + 14,
      'text-anchor': 'end',
      class: 'axis-label',
      fill: 'var(--text-secondary)',
    });
    label.textContent = row.label.length > 26 ? `${row.label.slice(0, 25)}…` : row.label;
    svg.append(label);

    // 4px rounded ends, anchored at the baseline.
    svg.append(
      svgEl('rect', {
        x: labelW,
        y: y + 3,
        width: w,
        height: 15,
        rx: 4,
        fill: row.color ?? 'var(--series-1)',
      }),
    );

    const value = svgEl('text', {
      x: labelW + w + 8,
      y: y + 15,
      class: 'value-label',
    });
    value.textContent = valueLabel(row);
    svg.append(value);

    const title = svgEl('title');
    title.textContent = `${row.label}: ${valueLabel(row)}`;
    svg.append(title);
  });

  return h('div', { class: 'chart' }, svg);
}

/**
 * One franchise's finish across seasons.
 *
 * Rank is inverted on the y-axis so "first" sits at the top, which is the only
 * reading anyone attempts. A rank line is drawn as a step-free polyline with
 * visible markers, since each point is a discrete season rather than a sample
 * of something continuous.
 */
function seasonLineChart(seasonStats) {
  const points = seasonStats.filter((s) => s.finish != null);
  if (points.length < 2) return null;

  const width = 720;
  const height = 210;
  const pad = { top: 16, right: 22, bottom: 30, left: 38 };
  const maxFinish = Math.max(...points.map((p) => p.finish), 4);
  const years = points.map((p) => p.year);

  const x = (year) =>
    pad.left +
    ((year - Math.min(...years)) / Math.max(1, Math.max(...years) - Math.min(...years))) *
      (width - pad.left - pad.right);
  const y = (finish) =>
    pad.top + ((finish - 1) / Math.max(1, maxFinish - 1)) * (height - pad.top - pad.bottom);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img',
    'aria-label': 'Finishing position by season' });

  for (let rank = 1; rank <= maxFinish; rank += Math.max(1, Math.floor(maxFinish / 5))) {
    svg.append(svgEl('line', { x1: pad.left, x2: width - pad.right, y1: y(rank), y2: y(rank), class: 'grid-line' }));
    const label = svgEl('text', { x: pad.left - 8, y: y(rank) + 4, 'text-anchor': 'end', class: 'axis-label' });
    label.textContent = rank;
    svg.append(label);
  }

  svg.append(
    svgEl('polyline', {
      points: points.map((p) => `${x(p.year)},${y(p.finish)}`).join(' '),
      fill: 'none',
      stroke: 'var(--series-1)',
      'stroke-width': 2,
      'stroke-linejoin': 'round',
    }),
  );

  for (const point of points) {
    // A 2px surface ring keeps markers legible where the line doubles back.
    svg.append(
      svgEl('circle', {
        cx: x(point.year),
        cy: y(point.finish),
        r: point.champion ? 6 : 4.5,
        fill: point.champion ? 'var(--gold)' : 'var(--series-1)',
        stroke: 'var(--surface-1)',
        'stroke-width': 2,
      }),
    );
    const title = svgEl('title');
    title.textContent =
      `${point.year}: finished ${point.finish}, ${point.wins}-${point.losses}` +
      (point.champion ? ' — champion' : '');
    svg.append(title);
  }

  for (const year of years) {
    if (years.length > 8 && year % 2 !== 0) continue;
    const label = svgEl('text', { x: x(year), y: height - 10, 'text-anchor': 'middle', class: 'axis-label' });
    label.textContent = String(year).slice(2);
    svg.append(label);
  }

  return h(
    'div',
    {},
    h(
      'p',
      { class: 'legend' },
      h('span', {}, h('span', { class: 'swatch', style: 'background: var(--gold)' }), 'Championship season'),
      h('span', {}, h('span', { class: 'swatch', style: 'background: var(--series-1)' }), 'Final position'),
    ),
    h('div', { class: 'chart' }, svg),
  );
}

// --- shared pieces ----------------------------------------------------------

const panel = (title, hint, ...body) =>
  h('section', { class: 'panel' }, h('h2', {}, title), hint && h('p', { class: 'hint' }, hint), ...body);

const table = (headers, rows) =>
  h(
    'div',
    { class: 'table-scroll' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, headers.map((col) =>
        h('th', { class: col.num ? 'num' : null, scope: 'col' }, col.label)))),
      h('tbody', {}, rows),
    ),
  );

function selector(label, options, value, onChange) {
  return h(
    'div',
    { class: 'controls' },
    h('label', { for: `sel-${label}` }, label),
    h(
      'select',
      { id: `sel-${label}`, onchange: (e) => onChange(e.target.value) },
      options.map((opt) =>
        h('option', { value: opt.value, selected: String(opt.value) === String(value) }, opt.label)),
    ),
  );
}

// --- views ------------------------------------------------------------------

function viewOverview() {
  const { league, franchises, seasons } = DATA;
  const titled = franchises
    .filter((f) => f.championships.length)
    .sort((a, b) => b.championships.length - a.championships.length || a.currentName.localeCompare(b.currentName));

  const tiles = h(
    'div',
    { class: 'tiles' },
    h('div', { class: 'tile' },
      h('div', { class: 'value' }, seasons.length),
      h('div', { class: 'label' }, 'Seasons'),
      h('div', { class: 'note' }, `${league.firstSeason}–${league.lastSeason}`)),
    h('div', { class: 'tile' },
      h('div', { class: 'value' }, franchises.length),
      h('div', { class: 'label' }, 'Franchises'),
      h('div', { class: 'note' }, `${franchises.filter((f) => f.seasons.length >= 10).length} with 10+ seasons`)),
    h('div', { class: 'tile' },
      h('div', { class: 'value' }, int(league.totalGames)),
      h('div', { class: 'label' }, 'Games played')),
    h('div', { class: 'tile' },
      h('div', { class: 'value' }, int(league.totalPicks)),
      h('div', { class: 'label' }, 'Draft picks')),
  );

  const championRows = seasons
    .slice()
    .reverse()
    .map((s) =>
      h('tr', {},
        h('td', { class: 'num' }, s.year),
        h('td', { class: 'name' },
          h('span', { class: 'trophy' }, '🏆 '),
          s.champion ?? '—',
          s.championId && nameOf(s.championId) !== s.champion
            ? h('span', { class: 'aka' }, `now ${nameOf(s.championId)}`)
            : null),
        h('td', { class: 'num' }, s.teams.length),
        h('td', { class: 'num' }, s.matchups.filter((m) => m.contested).length)));

  const bestPct = franchises.filter((f) => f.games >= 60).slice(0, 12);

  return [
    tiles,
    panel(
      'Championships',
      'Titles are tracked by franchise, so a team keeps its history through every rename.',
      barChart(
        titled.map((f) => ({ label: f.currentName, value: f.championships.length })),
        { valueLabel: (r) => `${r.value}` },
      ),
      h('details', {}, h('summary', {}, 'Show as table'),
        table(
          [{ label: 'Franchise' }, { label: 'Titles', num: true }, { label: 'Years' }],
          titled.map((f) =>
            h('tr', {},
              h('td', { class: 'name' }, f.currentName),
              h('td', { class: 'num' }, f.championships.length),
              h('td', {}, f.championships.join(', ')))),
        )),
    ),
    panel(
      'All-time record',
      'Franchises with at least 60 games, so a short stint cannot top the table on a hot streak.',
      table(
        [
          { label: '#' }, { label: 'Franchise' }, { label: 'W-L', num: true },
          { label: 'Win %', num: true }, { label: 'Seasons', num: true },
          { label: 'Points/game', num: true }, { label: 'Titles', num: true },
        ],
        bestPct.map((f, i) =>
          h('tr', {},
            h('td', { class: 'rank' }, i + 1),
            h('td', { class: 'name' }, f.currentName,
              f.names.length > 1 ? h('span', { class: 'aka' }, `aka ${f.names.slice(0, -1).join(', ')}`) : null),
            h('td', { class: 'num' }, record(f)),
            h('td', { class: 'num' },
              h('span', { class: 'bar-cell' },
                h('span', { class: 'bar-track' },
                  h('span', { class: 'bar-fill', style: `width: ${Math.round(f.winPct * 100)}%` })),
                pct(f.winPct))),
            h('td', { class: 'num' }, f.seasons.length),
            h('td', { class: 'num' }, num(f.pointsPerGame)),
            h('td', { class: 'num' }, f.championships.length || h('span', { class: 'muted' }, '—')))),
      ),
    ),
    panel('Season by season', null,
      table(
        [{ label: 'Year', num: true }, { label: 'Champion' }, { label: 'Teams', num: true }, { label: 'Games', num: true }],
        championRows,
      )),
  ];
}

function viewSeasons() {
  const year = state.season ?? DATA.league.lastSeason;
  const season = DATA.seasons.find((s) => s.year === year);
  if (!season) return [panel('Season', null, h('p', { class: 'empty' }, 'No such season'))];

  const control = selector(
    'Season',
    DATA.seasons.slice().reverse().map((s) => ({ value: s.year, label: s.year })),
    year,
    (value) => { state.season = Number(value); render(); },
  );

  const standings = table(
    [
      { label: 'Finish', num: true }, { label: 'Team' }, { label: 'Division' },
      { label: 'W-L', num: true }, { label: 'Win %', num: true },
      { label: 'Points for', num: true }, { label: 'Points against', num: true },
    ],
    season.teams
      .slice()
      .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || (b.pointsFor ?? 0) - (a.pointsFor ?? 0))
      .map((t) =>
        h('tr', {},
          h('td', { class: 'num' }, t.finish ?? '—'),
          h('td', { class: 'name' },
            t.name === season.champion ? h('span', { class: 'trophy' }, '🏆 ') : null,
            t.name),
          h('td', { class: 'muted' }, t.division ?? '—'),
          h('td', { class: 'num' }, record(t)),
          h('td', { class: 'num' }, pct(t.pct)),
          h('td', { class: 'num' }, num(t.pointsFor)),
          h('td', { class: 'num' }, num(t.pointsAgainst)))),
  );

  const weeks = [...new Set(season.matchups.map((m) => m.week))].filter((w) => w != null).sort((a, b) => a - b);
  const results = weeks.map((week) => {
    const games = season.matchups.filter((m) => m.week === week && m.contested);
    if (!games.length) return null;
    return h('details', { open: week === weeks[0] ? '' : null },
      h('summary', {}, `Week ${week} — ${games.length} games`),
      table(
        [{ label: 'Away' }, { label: '', num: true }, { label: 'Home' }, { label: '', num: true }],
        games.map((m) => {
          const awayWon = (m.awayScore ?? 0) > (m.homeScore ?? 0);
          return h('tr', {},
            h('td', { class: awayWon ? 'name' : null }, m.away),
            h('td', { class: 'num' }, num(m.awayScore)),
            h('td', { class: !awayWon ? 'name' : null }, m.home),
            h('td', { class: 'num' }, num(m.homeScore)));
        }),
      ));
  });

  return [
    control,
    panel(`${year} final standings`,
      season.champion ? `Champion: ${season.champion}` : null, standings),
    panel(`${year} results`, 'Winners in bold. Byes and unplayed bracket slots are omitted.', ...results.filter(Boolean)),
  ];
}

function viewFranchises() {
  const id = state.franchise ?? defaultFranchiseId();
  const franchise = byId.get(id);
  if (!franchise) return [panel('Franchises', null, h('p', { class: 'empty' }, 'No franchises'))];

  const control = selector(
    'Franchise',
    DATA.franchises
      .slice()
      .sort((a, b) => a.currentName.localeCompare(b.currentName))
      .map((f) => ({ value: f.teamId, label: `${f.currentName} (${f.seasons.length} seasons)` })),
    id,
    (value) => { state.franchise = value; render(); },
  );

  const tiles = h('div', { class: 'tiles' },
    h('div', { class: 'tile' },
      h('div', { class: 'value' }, record(franchise)),
      h('div', { class: 'label' }, 'All-time record'),
      h('div', { class: 'note' }, `${pct(franchise.winPct)} win rate`)),
    h('div', { class: 'tile' },
      h('div', { class: 'value' }, franchise.championships.length),
      h('div', { class: 'label' }, 'Championships'),
      h('div', { class: 'note' }, franchise.championships.join(', ') || 'None yet')),
    h('div', { class: 'tile' },
      h('div', { class: 'value' }, franchise.seasons.length),
      h('div', { class: 'label' }, 'Seasons'),
      h('div', { class: 'note' }, `${Math.min(...franchise.seasons)}–${Math.max(...franchise.seasons)}`)),
    h('div', { class: 'tile' },
      h('div', { class: 'value' }, num(franchise.pointsPerGame)),
      h('div', { class: 'label' }, 'Points per game')),
  );

  const chart = seasonLineChart(franchise.seasonStats);

  const history = table(
    [
      { label: 'Year', num: true }, { label: 'Known as' }, { label: 'Finish', num: true },
      { label: 'W-L', num: true }, { label: 'Points for', num: true }, { label: 'Points against', num: true },
    ],
    franchise.seasonStats
      .slice()
      .reverse()
      .map((s) =>
        h('tr', {},
          h('td', { class: 'num' }, s.year),
          h('td', { class: 'name' }, s.champion ? h('span', { class: 'trophy' }, '🏆 ') : null, s.name),
          h('td', { class: 'num' }, s.finish ?? '—'),
          h('td', { class: 'num' }, record(s)),
          h('td', { class: 'num' }, num(s.pointsFor)),
          h('td', { class: 'num' }, num(s.pointsAgainst)))),
  );

  return [
    control,
    tiles,
    franchise.names.length > 1
      ? panel('Names used', 'Same franchise, tracked by its CBS team id.',
          h('p', {}, franchise.names.join('  →  ')))
      : null,
    chart ? panel('Where they finished', 'Lower is better; gold marks a title.', chart) : null,
    panel('Season by season', null, history),
  ].filter(Boolean);
}

function viewHeadToHead() {
  const id = state.franchise ?? defaultFranchiseId();
  const franchise = byId.get(id);
  if (!franchise) return [panel('Head-to-head', null, h('p', { class: 'empty' }, 'No data'))];

  const control = selector(
    'Franchise',
    DATA.franchises
      .slice()
      .sort((a, b) => a.currentName.localeCompare(b.currentName))
      .map((f) => ({ value: f.teamId, label: f.currentName })),
    id,
    (value) => { state.franchise = value; render(); },
  );

  const rows = DATA.headToHead
    .filter((r) => r.teamId === id)
    .sort((a, b) => b.wins + b.losses - (a.wins + a.losses));

  if (!rows.length) return [control, panel('Head-to-head', null, h('p', { class: 'empty' }, 'No games recorded'))];

  const body = rows.map((r) => {
    const games = r.wins + r.losses + r.ties;
    const winPct = games ? (r.wins + r.ties / 2) / games : 0;
    return h('tr', {},
      h('td', { class: 'name' }, nameOf(r.opponentId)),
      h('td', { class: 'num' }, `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`),
      h('td', { class: 'num' },
        h('span', { class: 'bar-cell' },
          h('span', { class: 'bar-track' },
            h('span', {
              class: 'bar-fill',
              style: `width: ${Math.round(winPct * 100)}%; background: ${
                winPct >= 0.5 ? 'var(--series-1)' : 'var(--series-2)'
              }`,
            })),
          pct(winPct))),
      h('td', { class: 'num' }, num(r.pointsFor)),
      h('td', { class: 'num' }, num(r.pointsAgainst)),
      h('td', { class: 'num' }, num(r.pointsFor - r.pointsAgainst)));
  });

  const wins = rows.reduce((sum, r) => sum + r.wins, 0);
  const losses = rows.reduce((sum, r) => sum + r.losses, 0);

  return [
    control,
    panel(
      `${franchise.currentName} against everyone`,
      `${wins}-${losses} in ${wins + losses} head-to-head games. Bars are win rate; ` +
        `orange means a losing record. Byes and unplayed bracket slots excluded.`,
      table(
        [
          { label: 'Opponent' }, { label: 'Record', num: true }, { label: 'Win %', num: true },
          { label: 'Points for', num: true }, { label: 'Points against', num: true },
          { label: 'Differential', num: true },
        ],
        body,
      ),
    ),
  ];
}

function viewDrafts() {
  const withDrafts = DATA.seasons.filter((s) => s.draft?.picks.length);
  const year = state.draftYear ?? withDrafts[withDrafts.length - 1]?.year;
  const season = withDrafts.find((s) => s.year === year);
  if (!season) return [panel('Drafts', null, h('p', { class: 'empty' }, 'No draft data'))];

  const control = selector(
    'Draft',
    withDrafts.slice().reverse().map((s) => ({ value: s.year, label: `${s.year} (${s.draft.picks.length} picks)` })),
    year,
    (value) => { state.draftYear = Number(value); render(); },
  );

  const picks = season.draft.picks;
  const scored = picks.filter((p) => p.totalPoints != null && p.player);

  const best = scored.slice().sort((a, b) => b.totalPoints - a.totalPoints).slice(0, 10);
  const busts = scored
    .filter((p) => p.round != null && p.round <= 3)
    .sort((a, b) => a.totalPoints - b.totalPoints)
    .slice(0, 10);

  const pickTable = (list) =>
    table(
      [
        { label: 'Rd', num: true }, { label: 'Pick', num: true }, { label: 'Player' },
        { label: 'Pos' }, { label: 'Team' }, { label: 'Points', num: true },
      ],
      list.map((p) =>
        h('tr', {},
          h('td', { class: 'num' }, p.round ?? '—'),
          h('td', { class: 'num' }, p.pick ?? '—'),
          h('td', { class: 'name' }, p.player ?? h('span', { class: 'muted' }, 'no player recorded')),
          h('td', { class: 'muted' }, p.position ?? '—'),
          h('td', {}, p.team ?? '—'),
          h('td', { class: 'num' }, num(p.totalPoints)))),
    );

  return [
    control,
    panel(
      `${year} draft`,
      `${picks.length} picks${season.draft.label ? ` — ${season.draft.label} draft` : ''}. ` +
        (scored.length
          ? 'Points are what the player actually scored that season.'
          : 'CBS did not publish scoring on this season’s draft page, so points are unavailable.'),
      pickTable(picks),
    ),
    scored.length
      ? panel('Best picks of the draft', 'By points returned, any round.', pickTable(best))
      : null,
    busts.length
      ? panel('Early-round disappointments', 'Rounds 1–3 only, fewest points returned.', pickTable(busts))
      : null,
  ].filter(Boolean);
}

function viewRecords() {
  const withRecords = DATA.seasons.filter((s) => s.records.length);
  if (!withRecords.length) return [panel('Records', null, h('p', { class: 'empty' }, 'No records found'))];

  const grouped = new Map();
  for (const season of withRecords) {
    for (const entry of season.records) {
      if (!grouped.has(entry.record)) grouped.set(entry.record, []);
      grouped.get(entry.record).push({ ...entry, year: season.year });
    }
  }

  const panels = [...grouped.entries()].map(([label, entries]) => {
    const numeric = entries.filter((e) => e.value != null && !Number.isNaN(Number(e.value)));
    const sorted = numeric.length
      ? numeric.slice().sort((a, b) => Number(b.value) - Number(a.value))
      : entries;
    return panel(
      label,
      null,
      table(
        [{ label: 'Year', num: true }, { label: 'Team' }, { label: 'Value', num: true }],
        sorted.slice(0, 8).map((e) =>
          h('tr', {},
            h('td', { class: 'num' }, e.year),
            h('td', { class: 'name' }, e.team ?? '—'),
            h('td', { class: 'num' }, e.value == null ? '—' : num(Number(e.value), 2)))),
      ),
    );
  });

  return [
    h('p', { class: 'hint' }, `${grouped.size} record categories, as CBS tracked them each season.`),
    ...panels,
  ];
}

// --- shell ------------------------------------------------------------------

const VIEWS = {
  overview: viewOverview,
  seasons: viewSeasons,
  franchises: viewFranchises,
  h2h: viewHeadToHead,
  drafts: viewDrafts,
  records: viewRecords,
};

function render() {
  main.replaceChildren(...[VIEWS[state.view]()].flat().filter(Boolean));
  for (const button of document.querySelectorAll('#tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.view === state.view));
  }
  window.scrollTo({ top: 0 });
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  state.view = button.dataset.view;
  render();
});

document.getElementById('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const isDark =
    root.dataset.theme === 'dark' ||
    (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = isDark ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', root.dataset.theme);
  } catch {
    /* private mode; the choice just will not persist */
  }
});

try {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch {
  /* storage unavailable; fall back to the OS setting */
}

fetch('/league.json')
  .then((response) => {
    if (!response.ok) throw new Error(`Could not load league data (HTTP ${response.status})`);
    return response.json();
  })
  .then((data) => {
    DATA = data;
    byId = new Map(data.franchises.map((f) => [f.teamId, f]));
    document.getElementById('league-name').textContent = data.league.name ?? 'League History';
    document.getElementById('league-range').textContent =
      `${data.league.firstSeason}–${data.league.lastSeason} · ` +
      `${data.seasons.length} seasons · ${data.franchises.length} franchises`;
    document.title = `${data.league.name ?? 'League'} — History`;
    render();
  })
  .catch((error) => {
    main.replaceChildren(
      h('section', { class: 'panel error' },
        h('h2', {}, 'Could not load the league data'),
        h('p', {}, error.message),
        h('p', { class: 'hint' }, 'If this is a fresh checkout, run: npm run parse')),
    );
  });
