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
