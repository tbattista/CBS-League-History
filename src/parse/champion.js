import * as cheerio from 'cheerio';
import { clean } from './util.js';

/**
 * /history/champion/<year>
 *
 * Another edit form. It holds a count select, then one select per podium
 * position, and only positions the commissioner actually filled in carry a
 * `selected` attribute.
 *
 * Reading the first option instead would report a champion for every season
 * CBS has ever heard of, including ones the league never played -- these pages
 * return 200 for any year at all.
 */
export function parseChampion(html, { year } = {}) {
  const $ = cheerio.load(html);
  const table = $('#table_championship').get(0);
  if (!table) return { year, champion: null, runnersUp: [] };

  const chosen = [];
  $(table)
    .find('select')
    .each((_, select) => {
      const $option = $(select).find('option[selected]').first();
      if (!$option.length) return;
      const value = clean($option.text());
      if (value) chosen.push(value);
    });

  // The first select is "number of champions"; the names follow it.
  const names = chosen.filter((value) => !/^\d+$/.test(value));

  return {
    year,
    champion: names[0] ?? null,
    runnersUp: names.slice(1),
  };
}
