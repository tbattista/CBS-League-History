#!/usr/bin/env node
import { loadAuth, redact } from './auth.js';
import { Fetcher } from './http.js';
import { crawl, outputDir } from './crawl.js';
import { buildReport, printReport } from './report.js';

function parseFlags(argv) {
  const flags = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) flags[match[1]] = match[2] ?? true;
  }
  return flags;
}

/**
 * Confirm the cookie works before spending several hundred requests finding out
 * that it doesn't. Cheap, and it is the single most common failure.
 */
async function commandCheck() {
  const { cookie, userAgent, leagueUrl } = loadAuth();
  console.log(`League : ${leagueUrl}`);
  console.log(`Cookie : ${redact(cookie)}`);
  console.log(`\nRequesting league home page...`);

  const fetcher = new Fetcher({ cookie, userAgent });
  const result = await fetcher.get(leagueUrl);

  if (result.error) {
    console.error(`\nFAILED: network error -- ${result.error}`);
    process.exit(1);
  }
  if (result.isLoginWall) {
    console.error(
      `\nFAILED: CBS bounced us to the login page.\n` +
        `The cookie is expired or incomplete. Re-copy it from a freshly loaded ` +
        `league page while logged in.`,
    );
    process.exit(1);
  }
  if (!result.ok) {
    console.error(`\nFAILED: HTTP ${result.status} from ${result.finalUrl}`);
    process.exit(1);
  }

  const title = (result.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  console.log(`\nOK -- authenticated. HTTP ${result.status}, ${result.body.length} bytes`);
  console.log(`Page title: ${title || '<none>'}`);
  console.log(`\nLooks good. Run "npm run crawl" to archive the full history.`);
}

async function commandCrawl(flags) {
  const { cookie, userAgent, leagueUrl } = loadAuth();
  const maxPages = Number(flags['max-pages'] ?? 500);
  const delayMs = Number(flags.delay ?? 1000);
  const force = Boolean(flags.force);
  const dir = outputDir();

  console.log(`League   : ${leagueUrl}`);
  console.log(`Cookie   : ${redact(cookie)}`);
  console.log(`Max pages: ${maxPages}   Delay: ${delayMs}ms   Resume: ${!force}`);
  console.log(`Output   : ${dir}\n`);

  const fetcher = new Fetcher({ cookie, userAgent, delayMs });

  const { manifest, truncated, remaining } = await crawl({
    fetcher,
    leagueOrigin: leagueUrl,
    outDir: dir,
    maxPages,
    force,
    onProgress: (entry, { done, pending }) => {
      const status = entry.ok ? String(entry.status) : entry.isLoginWall ? 'LOGIN' : 'FAIL';
      const path = new URL(entry.url).pathname + new URL(entry.url).search;
      console.log(`[${String(done).padStart(4)}] ${status.padEnd(5)} q:${String(pending).padEnd(4)} ${path.slice(0, 90)}`);
    },
  });

  const archived = manifest.filter((e) => e.ok).length;
  console.log(`\nArchived ${archived}/${manifest.length} pages to ${dir}/raw/`);

  if (truncated) {
    console.log(
      `\nHit the ${maxPages}-page cap with ${remaining} URLs still queued.\n` +
        `Re-run with --max-pages=${maxPages * 2} to continue (it resumes, ` +
        `it will not re-fetch what it already has).`,
    );
  }

  console.log(`\nBuilding structural report...`);
  const { report } = buildReport(dir);
  printReport(report);
}

async function commandReport() {
  const { report } = buildReport(outputDir());
  printReport(report);
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

const commands = {
  check: () => commandCheck(),
  crawl: () => commandCrawl(flags),
  report: () => commandReport(),
};

if (!commands[command]) {
  console.log(
    `CBS league history scraper\n\n` +
      `  npm run check                 Verify the session cookie works\n` +
      `  npm run crawl                 Archive the full league history\n` +
      `  npm run report                Re-summarize what was archived\n\n` +
      `Crawl flags:\n` +
      `  --max-pages=N   page cap (default 500)\n` +
      `  --delay=MS      delay between requests (default 1000)\n` +
      `  --force         re-fetch everything instead of resuming\n`,
  );
  process.exit(command ? 1 : 0);
}

commands[command]().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
