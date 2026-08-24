import * as cheerio from 'cheerio';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Structural survey of whatever the crawl pulled down.
 *
 * This exists so the parsing step can be written against what CBS actually
 * serves instead of what we assume it serves. It reports the shape of each
 * page -- title, headings, table headers, row counts, years mentioned -- which
 * is enough to write selectors without anyone shipping hundreds of megabytes of
 * HTML around.
 */

const YEAR_PATTERN = /\b(19[89]\d|20[0-4]\d)\b/g;

export function summarizePage(html, entry) {
  const $ = cheerio.load(html);

  const tables = [];
  $('table').each((_, el) => {
    const $table = $(el);
    const headers = $table
      .find('tr')
      .first()
      .find('th, td')
      .map((_, cell) => $(cell).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter(Boolean);
    const rowCount = $table.find('tr').length;
    // Single-row tables are almost always layout scaffolding, not data.
    if (rowCount > 1 && headers.length > 1) {
      tables.push({ headers: headers.slice(0, 14), rowCount });
    }
  });

  const bodyText = $('body').text();
  const years = [...new Set(bodyText.match(YEAR_PATTERN) ?? [])].sort();

  return {
    url: entry.url,
    file: entry.file,
    title: $('title').first().text().trim() || null,
    headings: $('h1, h2')
      .map((_, el) => $(el).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter(Boolean)
      .slice(0, 8),
    tables,
    tableCount: tables.length,
    years,
    selectOptions: $('select')
      .map((_, el) => ({
        name: $(el).attr('name') || $(el).attr('id') || null,
        options: $(el)
          .find('option')
          .map((_, opt) => $(opt).text().trim())
          .get()
          .slice(0, 30),
      }))
      .get()
      .filter((s) => s.options.length > 1)
      .slice(0, 6),
  };
}

/**
 * Which per-season pages exist for which seasons.
 *
 * This is the completeness check. A crawl can report 500 pages archived and
 * zero failures while still missing eight of fifteen seasons -- that is exactly
 * what happened on the first real run, and nothing in the totals showed it.
 * A per-season grid makes a hole impossible to miss.
 */
const SEASON_PAGE_KINDS = [
  ['year-by-year', /\/history\/year-by-year\/(\d{4})$/],
  ['standings', /\/history\/standings\/(\d{4})$/],
  ['champion', /\/history\/champion\/(\d{4})$/],
  ['awards', /\/history\/awards\/(\d{4})$/],
  ['draft', /\/draft\/results\/(\d{4}):/],
];

export function buildCoverage(manifest) {
  const bySeason = new Map();

  for (const entry of manifest) {
    if (!entry.ok) continue;
    for (const [kind, pattern] of SEASON_PAGE_KINDS) {
      const match = entry.url.match(pattern);
      if (!match) continue;
      const year = match[1];
      if (!bySeason.has(year)) bySeason.set(year, new Set());
      bySeason.get(year).add(kind);
    }
  }

  const seasons = [...bySeason.keys()].sort();
  const kinds = SEASON_PAGE_KINDS.map(([kind]) => kind);

  return {
    kinds,
    seasons: seasons.map((year) => ({
      year,
      has: kinds.filter((kind) => bySeason.get(year).has(kind)),
      missing: kinds.filter((kind) => !bySeason.get(year).has(kind)),
    })),
  };
}

/**
 * Pages that fetched cleanly but carry almost no data.
 *
 * A table with a header and one row is the fingerprint of content the server
 * did not render -- loaded by JavaScript, or behind a control the crawler never
 * operated. It reads as success everywhere else: HTTP 200, file on disk, a
 * table present, a row in the coverage grid.
 *
 * This is how the first real run's draft results looked. Every draft page
 * archived "Pick | Team | Player | Elig" with a single row, for a draft with
 * 150+ picks, and nothing else in the report said otherwise.
 */
export function findThinPages(pages) {
  return pages
    .filter((page) => {
      if (page.tableCount === 0) return false;
      const biggest = Math.max(...page.tables.map((t) => t.rowCount));
      return biggest <= 2;
    })
    .map((page) => ({
      url: page.url,
      title: page.title,
      largestTable: Math.max(...page.tables.map((t) => t.rowCount)),
      headers: page.tables[0]?.headers ?? [],
    }));
}

export function buildReport(dataDir) {
  const manifestPath = join(dataDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest at ${manifestPath}. Run the crawl first.`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const pages = [];

  for (const entry of manifest) {
    if (!entry.ok || !entry.file) continue;
    const filePath = join(dataDir, entry.file);
    if (!existsSync(filePath)) continue;
    pages.push(summarizePage(readFileSync(filePath, 'utf8'), entry));
  }

  const allYears = new Set();
  for (const page of pages) for (const year of page.years) allYears.add(year);

  const failures = manifest.filter((e) => !e.ok);

  const report = {
    generatedAt: new Date().toISOString(),
    pagesCrawled: manifest.length,
    pagesArchived: pages.length,
    failures: failures.map((f) => ({
      url: f.url,
      status: f.status,
      isLoginWall: f.isLoginWall,
      error: f.error,
    })),
    seasonsDetected: [...allYears].sort(),
    coverage: buildCoverage(manifest),
    thinPages: findThinPages(pages),
    pages,
  };

  const reportPath = join(dataDir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return { report, reportPath };
}

/** Terminal digest -- the at-a-glance "did this work?" view. */
export function printReport(report) {
  const line = '-'.repeat(68);
  console.log(`\n${line}`);
  console.log(`Pages crawled : ${report.pagesCrawled}`);
  console.log(`Pages archived: ${report.pagesArchived}`);
  console.log(`Failures      : ${report.failures.length}`);
  console.log(
    `Seasons seen  : ${
      report.seasonsDetected.length
        ? `${report.seasonsDetected.length} (${report.seasonsDetected[0]}-${
            report.seasonsDetected[report.seasonsDetected.length - 1]
          })`
        : 'none detected'
    }`,
  );
  console.log(line);

  // Season coverage grid -- the completeness check.
  const coverage = report.coverage;
  if (coverage && coverage.seasons.length) {
    const width = Math.max(...coverage.kinds.map((k) => k.length));
    console.log(`\nPer-season coverage:\n`);
    console.log(`  ${' '.repeat(width)}  ${coverage.seasons.map((s) => s.year.slice(2)).join(' ')}`);
    for (const kind of coverage.kinds) {
      const cells = coverage.seasons.map((s) => (s.has.includes(kind) ? ' y' : ' .'));
      console.log(`  ${kind.padEnd(width)} ${cells.join('')}`);
    }

    const holes = coverage.seasons.filter((s) => s.missing.length);
    if (holes.length) {
      console.log(`\n  Gaps ( . above ):`);
      for (const season of holes) {
        console.log(`    ${season.year}: missing ${season.missing.join(', ')}`);
      }
      console.log(
        `\n  A gap is not necessarily a problem -- CBS may simply have no such\n` +
          `  page for that season. It is a problem if a season you remember is\n` +
          `  blank across the board.`,
      );
    } else {
      console.log(`\n  Complete: every season has every page type.`);
    }
    console.log(`\n${line}`);
  }

  const withTables = report.pages
    .filter((p) => p.tableCount > 0)
    .sort((a, b) => b.tableCount - a.tableCount);

  console.log(`\nPages containing data tables (${withTables.length}):\n`);
  for (const page of withTables.slice(0, 40)) {
    const path = new URL(page.url).pathname + new URL(page.url).search;
    console.log(`  ${path}`);
    console.log(`    title  : ${page.title ?? '-'}`);
    for (const table of page.tables.slice(0, 3)) {
      console.log(`    table  : ${table.rowCount} rows | ${table.headers.join(' | ')}`);
    }
    console.log('');
  }

  if (report.thinPages?.length) {
    console.log(
      `\nSuspiciously empty pages (${report.thinPages.length}) -- fetched fine,\n` +
        `but their biggest table has 2 rows or fewer. Usually means the content\n` +
        `is rendered by JavaScript rather than sent in the HTML:\n`,
    );
    for (const page of report.thinPages.slice(0, 20)) {
      const url = new URL(page.url);
      console.log(`  ${url.pathname}${url.search}`);
      console.log(`    ${page.largestTable} rows | ${page.headers.join(' | ')}`);
    }
  }

  if (report.failures.length) {
    console.log(`\nFailures:\n`);
    for (const failure of report.failures.slice(0, 20)) {
      const reason = failure.isLoginWall
        ? 'LOGIN WALL'
        : failure.error || `HTTP ${failure.status}`;
      console.log(`  [${reason}] ${failure.url}`);
    }
  }

  console.log(
    `\nFull structural report written to data/report.json ` +
      `-- that file is what the parsers get written against.\n`,
  );
}
