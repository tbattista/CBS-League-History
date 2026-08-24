import * as cheerio from 'cheerio';
import { cellValue, num, rowsOf } from './util.js';

/**
 * /history/standings/<year>
 *
 * This is the commissioner edit form, and it is the only page that exposes
 * CBS's internal team id. That id is what makes a franchise traceable: teams
 * rename constantly ("ill take the rapist" becomes "Anthony Micheletti" becomes
 * "Reid's Stache"), so names cannot identify anyone across seasons.
 *
 * Cells are addressed as `cell_<teamId>-<field>`, which is where both the id
 * and the field name come from -- no reliance on column order, which varies by
 * season (single-division years have no Division column).
 */
export function parseStandings(html, { year } = {}) {
  const $ = cheerio.load(html);
  const table = $('#table_form').get(0);
  if (!table) return { year, teams: [] };

  const byTeam = new Map();

  rowsOf($, table).each((_, row) => {
    $(row)
      .children('td')
      .each((_, cell) => {
        const id = ($(cell).attr('id') || '').replace(/^cell_/, '');
        const match = id.match(/^(\d+)-(.+)$/);
        if (!match) return;

        const [, teamId, field] = match;
        if (!byTeam.has(teamId)) byTeam.set(teamId, { teamId });
        byTeam.get(teamId)[field] = cellValue($, cell);
      });
  });

  const teams = [...byTeam.values()].map((raw) => ({
    teamId: raw.teamId,
    name: raw.Team ?? null,
    division: raw.division ?? null,
    finish: num(raw.finish),
    wins: num(raw.W),
    losses: num(raw.L),
    ties: num(raw.T),
    pct: num(raw.PCT),
    gamesBack: num(raw.GB),
    streak: raw.Streak ?? null,
    divisionRecord: raw.Div ?? null,
    weeksInFirst: num(raw.Wks),
    pointsFor: num(raw.PF),
    pointsAgainst: num(raw.PA),
    pointsBack: num(raw.Back),
  }));

  // Finish is per-division, so sorting by it alone interleaves divisions.
  teams.sort(
    (a, b) =>
      String(a.division ?? '').localeCompare(String(b.division ?? '')) ||
      (a.finish ?? 99) - (b.finish ?? 99),
  );

  return { year, teams };
}
