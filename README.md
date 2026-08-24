# CBS League History

Archive a CBS Sports fantasy league's full history off their site, then serve it
as a dashboard. Built because CBS displays years of league history but gives you
no way to export it — and a league that lives only on someone else's server is
one product decision away from gone.

**Status:** phase 1 (archival) is built and tested. Phase 2 (parsing) and phase 3
(dashboard) come next, written against real pages rather than guesses.

## Why it's split into phases

The scraper deliberately separates *fetching* from *parsing*:

1. **Fetch** — walk the league and snapshot every history page as raw HTML.
   This needs no knowledge of CBS's markup, so it works on the first run.
2. **Parse** — turn that HTML into structured data. This needs real markup,
   which is why it's written after step 1 has produced some.

The practical payoff: **your backup exists the moment step 1 finishes.** Raw HTML
on disk is the thing CBS can't take away from you. Parsed JSON is a convenience
that can always be regenerated from it — so if a parser turns out to be wrong in
six months, the source of truth is still sitting right there.

## Setup

```bash
npm install
```

### 1. Point it at your league

Your league URL is the subdomain you normally visit, e.g.
`https://yourleague.football.cbssports.com`. Baseball and basketball leagues use
`baseball.` / `basketball.` instead.

### 2. Give it your session

CBS history pages are server-rendered HTML behind a cookie check — no JS app, no
bot challenge. So a valid `Cookie` header is all that's needed.

Easiest way, no cookie-hunting required:

1. Open your league's history page in Chrome, logged in
2. DevTools → **Network** → reload → click the top document request
3. Right-click → **Copy** → **Copy as cURL**
4. Save it as `curl.txt` in this repo

On Windows, Chrome offers both **cmd** and **bash** variants. **Choose bash**,
even though you're on Windows — the file is only ever read as text, never
executed. The cmd form doubles every `%`, and CBS cookies are dense with
percent-encoded values, so a cmd copy arrives corrupt and CBS answers it with a
login redirect that looks exactly like an expired session. The parser repairs
cmd escaping if you grab it anyway, but bash avoids the problem entirely.

That one blob carries the cookies, your user-agent, and the league URL together,
so there's nothing to assemble by hand.

`curl.txt` and `.env` are both gitignored. **The cookie is a live credential** —
treat it like a password, and log out of CBS when you're done to invalidate it.
Alternatively, copy `.env.example` to `.env` and set the vars there (better for
Railway or CI).

### 3. Verify before committing to a full run

```bash
npm run check
```

Fetches one page and confirms you're actually authenticated. Takes a second, and
catches the most common failure — an expired cookie — before it wastes a few
hundred requests.

### 4. Archive everything

```bash
npm run crawl
```

Flags: `--max-pages=N` (default 1500), `--delay=MS` (default 1000),
`--force` (re-fetch instead of resuming).

Output lands in `data/`:

```
data/
  raw/           # every page, exactly as CBS served it — the actual backup
  manifest.json  # what was fetched, when, status, where it landed
  report.json    # structural survey: titles, table headers, seasons found
```

**Commit `data/` when the run finishes.** That's the whole point of the exercise.

## How the crawler finds pages

Two passes.

**Pass 1 follows the league's own navigation** from a handful of seeds, so
whatever CBS links to gets archived. No URL guessing.

**Pass 2 backfills by season.** Following links alone is not enough: older
seasons drop out of the navigation over time. Once pass 1 has found any season
page, the URL shape is known and seasons are just integers, so the rest can be
enumerated directly. The span walks outward until a round finds nothing new,
rather than being guessed up front.

This two-pass split came out of a real first run. It archived 500 pages with
zero failures and still had `year-by-year` for all 14 seasons but `standings`
for only the most recent 5 — the older seasons simply weren't linked anywhere.
Nothing in the totals showed it, which is why the report now prints a
per-season grid.

**Two filters keep the budget on actual history.** That same run spent 240 of
its 500 pages on nothing useful:

- **Sort permutations** (178 pages). CBS puts sort links on every table, and
  each is a distinct URL serving identical data — 32 copies of one page. Sort
  and pagination parameters are now stripped during URL normalization, so each
  table collapses to one canonical fetch.
- **Editorial and admin sections** (92 pages). News articles, mock drafts,
  draft-central advice, current-season player stats, commissioner settings —
  all linked from league nav, none of it league history. Now excluded by
  section. `/setup/` is excluded doubly: those pages administer the league
  (add year, remove years, manage teams), and while the archiver only ever
  issues GETs, it has no business near them.

Other deliberate behaviours worth knowing:

- **It never follows `/logout`.** Ending your own session mid-crawl would be an
  annoying way to lose a run.
- **It stays on the league subdomain.** CBS proper is an effectively unbounded
  crawl surface.
- **It refuses to archive login pages as data.** An expired cookie returns a
  perfectly valid `200` containing nothing you want; several in a row aborts the
  run loudly instead of writing hundreds of useless files that look like success.
- **It resumes.** Interrupted runs pick up where they left off; pages already
  archived aren't re-fetched.
- **It writes incrementally.** A run that dies on page 200 leaves 199 pages of
  real backup behind.
- **One request per second by default.** This is a league archive, not a load
  test.

## Reading the results

`npm run crawl` prints a structural summary at the end, and `npm run report`
regenerates it without re-fetching.

First is the **per-season coverage grid** — the completeness check:

```
                 12 13 14 15 16 17 18 19 20 21 22 23 24 25
  year-by-year    y  y  y  y  y  y  y  y  y  y  y  y  y  y
  standings       .  .  .  .  .  .  .  .  .  y  y  y  y  y
  champion        .  .  .  .  .  .  .  .  y  y  y  y  y  y
```

A `.` is not automatically a problem — CBS may have no such page for that
season. It *is* a problem when a season you remember is blank across the board.
Check this before trusting the archive.

Then a list of every page containing data tables, with column headers and row
counts. That part is what phase 2's parsers get written against — it describes
the shape of your league's pages without anyone shipping megabytes of HTML
around.

## Tests

```bash
npm test
```

20 tests, covering cURL parsing across platforms (including Windows cmd
percent-escaping), cookie redaction, login-wall detection, crawl-scope rules,
sort-permutation collapsing, season backfill, coverage gap detection, filename
safety, and a full end-to-end crawl against a mock CBS league that reproduces
the real site's cookie gating, sort links, editorial noise, and — importantly —
older seasons reachable only by URL, never by link.

## Deployment

Railway is the target for the dashboard (phase 3). Note that the **scraper**
wants to run wherever you can get a fresh session cookie — usually your own
machine — while the **site** is what gets deployed. They share this repo and the
committed `data/`, but they don't have to run in the same place.
