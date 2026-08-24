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

Flags: `--max-pages=N` (default 500), `--delay=MS` (default 1000),
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

It doesn't guess URLs. It starts from a handful of seeds and follows the
league's own navigation, so whatever CBS links to is what gets archived.

This matters for an old league. CBS's URL scheme has changed over the years, and
a 12–14 season league likely spans more than one generation of it. Hardcoded URL
patterns would silently miss entire seasons — and a backup with a hole in it
still looks complete, which is the worst failure mode available here.

Some deliberate behaviours worth knowing:

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
regenerates it without re-fetching. It lists every page containing data tables,
with their column headers and row counts.

That summary is what phase 2's parsers get written against — it describes the
shape of your league's pages without anyone shipping megabytes of HTML around.

## Tests

```bash
npm test
```

14 tests, covering cURL parsing across platforms, cookie redaction, login-wall
detection, crawl-scope rules, filename safety, and a full end-to-end crawl
against a mock CBS league that reproduces the real site's cookie gating and
link-only season discovery.

## Deployment

Railway is the target for the dashboard (phase 3). Note that the **scraper**
wants to run wherever you can get a fresh session cookie — usually your own
machine — while the **site** is what gets deployed. They share this repo and the
committed `data/`, but they don't have to run in the same place.
