import * as cheerio from 'cheerio';
import { clean, num, rowsOf, parsePlayer, rowText } from './util.js';

/**
 * /draft/results/<year>:<label>:<label>
 *
 * Rows are typed by class: `subtitle` opens a round ("Round 1"), `label` is the
 * column header, and `row1`/`row2` alternate for the picks themselves. The
 * round only ever appears in that banner row, so it has to be carried forward.
 *
 * That banner is also what made these tables look empty for most of this
 * project: it is a single cell, and a parser that assumes row one is the header
 * reads the whole table as one column of junk and discards it.
 */
export function parseDraft(html, { year, label } = {}) {
  const $ = cheerio.load(html);

  let table = null;
  $('table').each((_, el) => {
    if (table) return;
    if (rowsOf($, el).filter((_, r) => /row[12]/.test($(r).attr('class') || '')).length > 0) {
      table = el;
    }
  });
  if (!table) return { year, label, picks: [] };

  let columns = [];
  let round = null;
  const picks = [];

  rowsOf($, table).each((_, row) => {
    const $row = $(row);
    const rowClass = $row.attr('class') || '';
    const cells = rowText($, row);

    if (/subtitle/.test(rowClass)) {
      const match = (cells.find(Boolean) || '').match(/round\s*(\d+)/i);
      if (match) round = Number(match[1]);
      return;
    }

    if (/label/.test(rowClass)) {
      columns = cells.map((c) => (c || '').toLowerCase());
      return;
    }

    if (!/row[12]/.test(rowClass)) return;

    const at = (name) => {
      const index = columns.indexOf(name);
      return index === -1 ? null : cells[index];
    };

    // Older seasons label the column "Rnd/Pk" and newer ones "Pick".
    const pickCell = at('pick') ?? at('rnd/pk');
    const { player, position } = parsePlayer(at('player'));

    /*
     * A pick with no player is still a pick.
     *
     * These are real rows: a team on the clock, time elapsed -- one took four
     * and a half minutes -- and no player recorded, scoring 0.0. Auto-skips, or
     * players CBS has since dropped from its database. Discarding them would
     * quietly shorten the draft and renumber nothing, so the loss would not
     * show up anywhere. Keep them, and let the reader see the gap.
     */
    if (!player && !at('team')) return;

    picks.push({
      round,
      pick: num(pickCell),
      team: at('team'),
      player,
      position: position ?? clean(at('elig')),
      elapsed: at('elapsed time'),
      totalPoints: num(at('total fpts')),
      activePoints: num(at('active fpts')),
    });
  });

  return { year, label, picks };
}

/** `/draft/results/2015:Official:Official` -> { year: 2015, label: 'Official' } */
export function draftUrlInfo(url) {
  const match = url.match(/\/draft\/results\/(\d{4})(?::([^:/?]+))?/);
  if (!match) return null;
  return { year: Number(match[1]), label: match[2] ?? null };
}
