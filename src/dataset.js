import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseStandings } from './parse/standings.js';
import { parseYearByYear } from './parse/year-by-year.js';
import { parseChampion } from './parse/champion.js';
import { parseDraft, draftUrlInfo } from './parse/draft.js';

/**
 * Turn the raw archive into one normalized dataset.
 *
 * Source of truth per field, chosen from what each page actually carries:
 *
 *   standings/<year>     team ids, divisions, finish, full record
 *   year-by-year/<year>  records, champion, matchups (plain HTML, not a form)
 *   champion/<year>      champion confirmation
 *   draft/results/...    picks
 *
 * The awards pages are deliberately ignored. This league never filled them in
 * -- most seasons have zero assignments, and the one 2015 entry contradicts
 * both other champion sources. Importing that would add wrong data, not thin
 * data, which is worse.
 */

/** Prefer the draft variant that actually has picks; ties go to the fuller one. */
const DRAFT_LABEL_PRIORITY = ['Official', 'Season', 'Pre-season'];

function readManifest(dataDir) {
  const path = join(dataDir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`No manifest at ${path}. Run the crawl first.`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readPage(dataDir, entry) {
  // Manifests written on Windows use backslashes; accept either separator.
  const path = join(dataDir, ...entry.file.split(/[\\/]/));
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function buildDataset(dataDir) {
  const manifest = readManifest(dataDir);
  const seasons = new Map();
  const season = (year) => {
    if (!seasons.has(year)) {
      seasons.set(year, {
        year,
        champion: null,
        teams: [],
        matchups: [],
        records: [],
        draft: null,
      });
    }
    return seasons.get(year);
  };

  const draftCandidates = new Map();
  let leagueName = null;

  for (const entry of manifest) {
    if (!entry.ok || !entry.file) continue;
    const html = readPage(dataDir, entry);
    if (!html) continue;

    if (!leagueName) {
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
      const name = title.replace(/\s*-\s*CBSSports\.com\s*$/i, '').trim();
      if (name) leagueName = name;
    }

    const url = entry.url;
    let match;

    if ((match = url.match(/\/history\/standings\/(\d{4})$/))) {
      const year = Number(match[1]);
      const parsed = parseStandings(html, { year });
      if (parsed.teams.length) season(year).teams = parsed.teams;
      continue;
    }

    if ((match = url.match(/\/history\/year-by-year\/(\d{4})$/))) {
      const year = Number(match[1]);
      const parsed = parseYearByYear(html, { year });
      const target = season(year);
      if (parsed.matchups.length) target.matchups = parsed.matchups;
      if (parsed.records.length) target.records = parsed.records;
      if (parsed.champion) target.champion = parsed.champion;
      target.seasonTeams = parsed.teams;
      continue;
    }

    if ((match = url.match(/\/history\/champion\/(\d{4})$/))) {
      const year = Number(match[1]);
      const parsed = parseChampion(html, { year });
      if (parsed.champion) season(year).championConfirmed = parsed.champion;
      continue;
    }

    const draft = draftUrlInfo(url);
    if (draft) {
      const parsed = parseDraft(html, draft);
      if (parsed.picks.length) {
        const existing = draftCandidates.get(draft.year);
        if (!existing || better(parsed, existing)) draftCandidates.set(draft.year, parsed);
      }
    }
  }

  for (const [year, draft] of draftCandidates) season(year).draft = draft;

  // Only seasons with real evidence. CBS answers 200 for any year, so a page
  // existing proves nothing; a season needs teams or matchups to be real.
  const list = [...seasons.values()]
    .filter((s) => s.teams.length > 0 || s.matchups.length > 0)
    .sort((a, b) => a.year - b.year);

  for (const entry of list) {
    // Prefer the champion page when the two sources disagree; it is the value
    // a commissioner set explicitly rather than one derived from a stats table.
    if (entry.championConfirmed) entry.champion = entry.championConfirmed;
    delete entry.championConfirmed;
    reconcileSeasonTeams(entry);
    delete entry.seasonTeams;
  }

  return {
    league: {
      name: leagueName,
      seasons: list.map((s) => s.year),
      firstSeason: list[0]?.year ?? null,
      lastSeason: list[list.length - 1]?.year ?? null,
    },
    franchises: buildFranchises(list),
    seasons: list,
  };
}

function better(candidate, existing) {
  const rank = (d) => {
    const index = DRAFT_LABEL_PRIORITY.indexOf(d.label);
    return index === -1 ? DRAFT_LABEL_PRIORITY.length : index;
  };
  if (candidate.picks.length !== existing.picks.length) {
    return candidate.picks.length > existing.picks.length;
  }
  return rank(candidate) < rank(existing);
}

/**
 * The standings form has ids but no per-week context; year-by-year has the
 * fuller stat line but only names. Merge on name so each team keeps both.
 */
function reconcileSeasonTeams(entry) {
  if (!entry.seasonTeams?.length) return;
  const byName = new Map(entry.seasonTeams.map((t) => [t.name, t]));
  for (const team of entry.teams) {
    const extra = byName.get(team.name);
    if (!extra) continue;
    for (const key of ['wins', 'losses', 'ties', 'pct', 'pointsFor', 'pointsAgainst']) {
      if (team[key] == null && extra[key] != null) team[key] = extra[key];
    }
  }
  // A team present in year-by-year but absent from the standings form still
  // belongs in the season -- better an id-less record than a missing team.
  for (const extra of entry.seasonTeams) {
    if (!entry.teams.some((t) => t.name === extra.name)) {
      entry.teams.push({ teamId: null, ...extra });
    }
  }
}

/**
 * A franchise is a CBS team id, tracked across every season it appears in.
 *
 * Names are useless as identity here: teams rename constantly, and two distinct
 * franchises in this league have both been called "The Bernies". The id is what
 * holds a history together.
 */
function buildFranchises(seasons) {
  const byId = new Map();

  for (const season of seasons) {
    for (const team of season.teams) {
      if (!team.teamId) continue;
      if (!byId.has(team.teamId)) {
        byId.set(team.teamId, {
          teamId: team.teamId,
          names: [],
          seasons: [],
          wins: 0,
          losses: 0,
          ties: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          championships: [],
        });
      }
      const franchise = byId.get(team.teamId);
      if (team.name && !franchise.names.includes(team.name)) franchise.names.push(team.name);
      franchise.seasons.push(season.year);
      franchise.wins += team.wins ?? 0;
      franchise.losses += team.losses ?? 0;
      franchise.ties += team.ties ?? 0;
      franchise.pointsFor += team.pointsFor ?? 0;
      franchise.pointsAgainst += team.pointsAgainst ?? 0;
      if (season.champion && team.name === season.champion) {
        franchise.championships.push(season.year);
      }
    }
  }

  return [...byId.values()]
    .map((f) => ({
      ...f,
      // The name it went by most recently reads better than its first.
      currentName: f.names[f.names.length - 1] ?? null,
      games: f.wins + f.losses + f.ties,
      pointsFor: round(f.pointsFor),
      pointsAgainst: round(f.pointsAgainst),
      pointsPerGame: round(f.pointsFor / Math.max(1, f.wins + f.losses + f.ties), 1),
      winPct: round((f.wins + f.ties / 2) / Math.max(1, f.wins + f.losses + f.ties), 4),
    }))
    // Win pct alone puts a two-season cameo above a fourteen-season franchise,
    // so ties in rate are broken by how long the team actually played.
    .sort((a, b) => b.winPct - a.winPct || b.games - a.games);
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function writeDataset(dataDir, dataset) {
  const path = join(dataDir, 'league.json');
  writeFileSync(path, JSON.stringify(dataset, null, 2), 'utf8');
  return path;
}
