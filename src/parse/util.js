/**
 * Shared helpers for reading CBS's history pages.
 *
 * Two quirks drive most of this:
 *
 * 1. Several history pages are commissioner *edit forms*, not display pages.
 *    The values live in `<input value>` and `<select>`, so reading cell text
 *    returns empty strings for an otherwise perfectly populated season.
 *
 * 2. An unset `<select>` still has a first option. Anything that treats that
 *    as the value invents data -- reading the awards form that way credited
 *    every award in 2015 to whoever sorted first alphabetically.
 */

/** Collapse whitespace, and treat CBS's various blanks as null. */
export function clean(text) {
  if (text == null) return null;
  const value = String(text).replace(/\s+/g, ' ').trim();
  if (value === '' || value === '-' || value === '--' || value === '*') return null;
  return value;
}

export function num(text) {
  const value = clean(text);
  if (value == null) return null;

  /*
   * Strip formatting, then insist on something numeric actually remaining.
   *
   * Number('') is 0, not NaN, so a naive strip-and-convert turns every
   * non-numeric cell into a confident zero. That is how the header row "Team |
   * W | L | T" became a franchise with an 0-0-0 record in every season -- it
   * did not look like bad data, it looked like a team that never played.
   */
  const stripped = value.replace(/[^0-9.\-]/g, '');
  if (!/\d/.test(stripped)) return null;

  const parsed = Number(stripped);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The value of a form cell.
 *
 * Only an option carrying an explicit `selected` attribute counts. cheerio's
 * `:selected` (like a browser) falls back to the first option, which would turn
 * "nothing chosen" into a confident wrong answer.
 */
export function cellValue($, cell) {
  const $cell = $(cell);

  const $input = $cell.find('input:not([type=hidden])').first();
  if ($input.length) return clean($input.attr('value'));

  const $option = $cell.find('select option[selected]').first();
  if ($option.length) return clean($option.text());

  // A select with no explicit selection has no value, whatever it displays.
  if ($cell.find('select').length) return null;

  const $hidden = $cell.find('input[type=hidden]').first();
  if ($hidden.length) return clean($hidden.attr('value'));

  return clean($cell.text());
}

/** Direct child rows, so nested layout tables stay out of the count. */
export function rowsOf($, table) {
  return $(table).find('> tbody > tr, > thead > tr, > tr');
}

export function cellsOf($, row) {
  return $(row).children('th, td');
}

/**
 * Cell text for one row, as a plain array with blanks preserved.
 *
 * Cheerio's `.map(...).get()` drops null and undefined returns, so mapping
 * cells straight through `clean()` silently removes every empty cell and
 * shifts all later columns left. On a real draft page -- where "Elig" is
 * routinely blank -- that slid points into the elapsed-time column, producing
 * plausible-looking values in the wrong fields rather than an obvious error.
 */
export function rowText($, row) {
  return cellsOf($, row)
    .map((_, cell) => $(cell).text())
    .get()
    .map(clean);
}

/** Header text of a table's widest row, used to identify which table this is. */
export function headerOf($, table) {
  const $rows = rowsOf($, table);
  const widths = $rows.map((_, r) => cellsOf($, r).length).get();
  const widest = Math.max(0, ...widths);
  if (widest < 2) return [];
  const index = widths.findIndex((w) => w === widest);
  return cellsOf($, $rows.eq(index))
    .map((_, c) => $(c).text().trim().replace(/\s+/g, ' '))
    .get();
}

/** Find the first table whose header matches every one of `required`. */
export function findTable($, required) {
  let match = null;
  $('table').each((_, el) => {
    if (match) return;
    const header = headerOf($, el).map((h) => h.toLowerCase());
    const ok = required.every((want) => header.includes(want.toLowerCase()));
    if (ok) match = el;
  });
  return match;
}

/**
 * Split CBS's player cell: "Adrian Peterson RB •" -> name + position.
 * The bullet marks NFL-team info that is not present in the archived text.
 */
const POSITIONS = 'QB|RB|WR|TE|K|DST|DEF|D/ST|LB|DL|DB|PK';

export function parsePlayer(text) {
  const value = clean(text);
  if (!value) return { player: null, position: null, nflTeam: null };

  /*
   * Two formats, both live in this archive:
   *
   *   "Adrian Peterson RB •"          older seasons -- nothing after the bullet
   *   "Odell Beckham Jr. WR • NYG"    newer seasons -- NFL team after it
   *
   * Matching only the first shape leaves every newer pick with a null position
   * and the club abbreviation glued onto the player's name.
   */
  const full = value.match(new RegExp(`^(.*?)\\s+(${POSITIONS})\\s*[•·]\\s*([A-Za-z]{2,4})?$`, 'i'));
  if (full) {
    return {
      player: clean(full[1]),
      position: full[2].toUpperCase(),
      nflTeam: full[3] ? full[3].toUpperCase() : null,
    };
  }

  const stripped = value.replace(/\s*[•·]\s*$/, '').trim();
  const trailing = stripped.match(new RegExp(`^(.*?)\\s+(${POSITIONS})$`, 'i'));
  if (trailing) {
    return { player: clean(trailing[1]), position: trailing[2].toUpperCase(), nflTeam: null };
  }

  return { player: stripped, position: null, nflTeam: null };
}

/** "73.1 - 94.6" -> [73.1, 94.6]. Returns nulls when unscored. */
export function parseScore(text) {
  const value = clean(text);
  if (!value) return [null, null];
  const match = value.match(/(-?[\d.]+)\s*-\s*(-?[\d.]+)/);
  if (!match) return [null, null];
  return [Number(match[1]), Number(match[2])];
}
