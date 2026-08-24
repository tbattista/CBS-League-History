import * as cheerio from 'cheerio';
import { clean, num, rowsOf, headerOf, parseScore, rowText } from './util.js';

/**
 * /history/year-by-year/<year>
 *
 * The richest page in the archive, and the only one that is plain rendered
 * HTML rather than an edit form. It carries four things:
 *
 *   - season records ("Most Points Scored, Game" and friends)
 *   - the league champion
 *   - final standings with W/L/T, PCT, PF, PA
 *   - every matchup, week by week
 *
 * Week numbers come from the wrapper element's class -- CBS nests each week's
 * table in `div.tableResultsPeriodByPeriod.periodN`. There is no visible week
 * heading next to the table, so document order would otherwise be the only
 * clue, and that silently misnumbers everything if a week is ever missing.
 */
export function parseYearByYear(html, { year } = {}) {
  const $ = cheerio.load(html);

  const records = [];
  let champion = null;
  const teams = [];
  const matchups = [];

  $('table').each((_, el) => {
    const header = headerOf($, el).map((h) => h.toLowerCase());

    // Records tables: Record | Team | Value
    if (header.includes('record') && header.includes('team') && header.includes('value')) {
      rowsOf($, el).each((i, row) => {
        if (i === 0) return; // header
        const cells = rowText($, row);
        if (cells.length < 2) return;
        const [label, team, value] = cells;
        if (!label) return;

        // The champion is filed as a "record" rather than given its own table.
        if (/league champion/i.test(label)) {
          champion = team ?? null;
          return;
        }
        records.push({ record: label, team: team ?? null, value: value ?? null });
      });
      return;
    }

    // Season standings: Team | W | L | T | PCT | PF | PA | Wks
    if (header[0] === 'team' && header.includes('w') && header.includes('pct')) {
      const columns = headerOf($, el).map((h) => h.toLowerCase());
      rowsOf($, el).each((i, row) => {
        if (i === 0) return;
        const cells = rowText($, row);
        if (cells.length < 4 || !cells[0]) return;
        const at = (name) => {
          const index = columns.indexOf(name);
          return index === -1 ? null : cells[index];
        };

        const wins = num(at('w'));
        const losses = num(at('l'));

        /*
         * CBS repeats the header row inside the table -- once per division, and
         * again above the totals. Those rows are structurally identical to data
         * rows, so index alone cannot skip them, and letting one through adds a
         * phantom franchise called "Team" with an 0-0-0 record to every season.
         *
         * A real row has a numeric win column; a header has the letter "W".
         */
        if (wins == null && losses == null) return;

        teams.push({
          name: cells[0],
          wins,
          losses,
          ties: num(at('t')),
          pct: num(at('pct')),
          pointsFor: num(at('pf')),
          pointsAgainst: num(at('pa')),
          weeksInFirst: num(at('wks')),
        });
      });
      return;
    }

    // Weekly results: Away Team | Home Team | Results
    if (header.includes('away team') && header.includes('home team')) {
      const week = weekOf($, el);
      rowsOf($, el).each((i, row) => {
        if (i === 0) return;
        const cells = rowText($, row);
        if (cells.length < 3) return;
        const [away, home, result] = cells;
        if (!home) return;

        const [awayScore, homeScore] = parseScore(result);

        /*
         * Not every row is a game between two teams.
         *
         * "BYE" is a real team scored against nobody. "TBA" is an unplayed
         * playoff bracket slot -- CBS renders the empty half of a bracket that
         * way, and there are 16-22 of them in every season. Treating either as
         * an opponent invents a franchise and hands out free wins.
         */
        const isPlaceholder = (name) => name != null && /^(BYE|TBA|TBD)$/i.test(name);

        matchups.push({
          week,
          away: isPlaceholder(away) ? null : away,
          home: isPlaceholder(home) ? null : home,
          awayScore,
          homeScore,
          bye: /^BYE$/i.test(away ?? '') || /^BYE$/i.test(home ?? ''),
          // Both sides real, so the result counts toward head-to-head.
          contested: !isPlaceholder(away) && !isPlaceholder(home) && away != null && home != null,
        });
      });
    }
  });

  return { year, champion, records, teams, matchups };
}

/** Week number from `div.tableResultsPeriodByPeriod.periodN` up the tree. */
function weekOf($, table) {
  const $wrapper = $(table).closest('[class*="period"]');
  const match = ($wrapper.attr('class') || '').match(/\bperiod(\d+)\b/);
  return match ? Number(match[1]) : null;
}
