import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clean, num, parsePlayer, parseScore } from '../src/parse/util.js';
import { parseStandings } from '../src/parse/standings.js';
import { parseYearByYear } from '../src/parse/year-by-year.js';
import { parseChampion } from '../src/parse/champion.js';
import { parseDraft, draftUrlInfo } from '../src/parse/draft.js';

test('num refuses to turn non-numeric text into zero', () => {
  // Number('') is 0, so a naive strip-and-convert reads the header cell "W" as
  // a score of nothing. That produced a phantom 0-0-0 franchise per season.
  assert.equal(num('W'), null);
  assert.equal(num('Team'), null);
  assert.equal(num('-'), null);
  assert.equal(num(''), null);
  assert.equal(num('12'), 12);
  assert.equal(num('0.800'), 0.8);
  assert.equal(num('1,623.1'), 1623.1);
  assert.equal(num('0'), 0, 'a real zero must survive');
});

test('clean normalizes CBS placeholders to null', () => {
  assert.equal(clean('  Team   Of  Stars '), 'Team Of Stars');
  assert.equal(clean('*'), null);
  assert.equal(clean('--'), null);
  assert.equal(clean(''), null);
});

test('parsePlayer splits name from position', () => {
  assert.deepEqual(parsePlayer('Adrian Peterson RB •'), {
    player: 'Adrian Peterson',
    position: 'RB',
  });
  assert.deepEqual(parsePlayer('Rob Gronkowski TE'), {
    player: 'Rob Gronkowski',
    position: 'TE',
  });
  // A name with no trailing position must not lose its last word.
  assert.deepEqual(parsePlayer('Seattle Seahawks'), {
    player: 'Seattle Seahawks',
    position: null,
  });
});

test('parseScore handles results and blanks', () => {
  assert.deepEqual(parseScore('73.1 - 94.6'), [73.1, 94.6]);
  assert.deepEqual(parseScore('0.0 - 111.4'), [0, 111.4]);
  assert.deepEqual(parseScore(''), [null, null]);
});

// --- standings -------------------------------------------------------------

const STANDINGS_HTML = `
<table id="table_form"><tbody>
  <tr><td>Division</td><td>Finish</td><td>Team</td><td>W</td><td>L</td><td>PF</td></tr>
  <tr>
    <td id="cell_13-division"><select id="13-division">
      <option selected value="2 Division">2 Division</option>
      <option value="1 Division">1 Division</option></select></td>
    <td id="cell_13-finish"><input type="text" name="form::13-finish" value="1"></td>
    <td id="cell_13-Team"><input type="hidden" name="form::13-Team" value="Jtucci74">
        <span id="13-Team">Jtucci74</span></td>
    <td id="cell_13-W"><input type="text" name="form::13-W" value="12"></td>
    <td id="cell_13-L"><input type="text" name="form::13-L" value="3"></td>
    <td id="cell_13-PF"><input type="text" name="form::13-PF" value="1623.1"></td>
  </tr>
  <tr>
    <td id="cell_9-division"><select id="9-division">
      <option value="2 Division">2 Division</option>
      <option selected value="1 Division">1 Division</option></select></td>
    <td id="cell_9-finish"><input type="text" name="form::9-finish" value="2"></td>
    <td id="cell_9-Team"><input type="hidden" name="form::9-Team" value="Team Of Stars"></td>
    <td id="cell_9-W"><input type="text" name="form::9-W" value="7"></td>
    <td id="cell_9-L"><input type="text" name="form::9-L" value="7"></td>
    <td id="cell_9-PF"><input type="text" name="form::9-PF" value="1457.2"></td>
  </tr>
</tbody></table>`;

test('parseStandings reads values out of the edit form, keyed by team id', () => {
  const { teams } = parseStandings(STANDINGS_HTML, { year: 2015 });
  assert.equal(teams.length, 2, 'the header row must not become a team');

  const jt = teams.find((t) => t.teamId === '13');
  assert.equal(jt.name, 'Jtucci74');
  assert.equal(jt.wins, 12);
  assert.equal(jt.losses, 3);
  assert.equal(jt.pointsFor, 1623.1);
  assert.equal(jt.finish, 1);
  // Only the option carrying the attribute counts.
  assert.equal(jt.division, '2 Division');
  assert.equal(teams.find((t) => t.teamId === '9').division, '1 Division');
});

// --- year by year ----------------------------------------------------------

const YBY_HTML = `
<table class="data data4">
  <tr><td>Record</td><td>Team</td><td>Value</td></tr>
  <tr><td>Most Points Scored, Game</td><td>Anthony Micheletti</td><td>172.2800</td></tr>
  <tr><td>League Champion</td><td>Anthony Micheletti</td><td></td></tr>
</table>
<table class="data data4 borderTop">
  <tr><td>Team</td><td>W</td><td>L</td><td>T</td><td>PCT</td><td>PF</td><td>PA</td></tr>
  <tr><td>Jtucci74</td><td>12</td><td>3</td><td>0</td><td>0.800</td><td>1623.1</td><td>1251.9</td></tr>
  <tr><td>Team</td><td>W</td><td>L</td><td>T</td><td>PCT</td><td>PF</td><td>PA</td></tr>
  <tr><td>NY Chaos</td><td>8</td><td>7</td><td>0</td><td>0.533</td><td>1593.6</td><td>1413.0</td></tr>
</table>
<div class="tableResultsPeriodByPeriod period1"><table class="data">
  <tr><td>Away Team</td><td>Home Team</td><td>Results</td></tr>
  <tr><td>The Bernies</td><td>Joe Buck Yourself</td><td>81.5 - 117.8</td></tr>
</table></div>
<div class="tableResultsPeriodByPeriod period15"><table class="data">
  <tr><td>Away Team</td><td>Home Team</td><td>Results</td></tr>
  <tr><td>BYE</td><td>Jtucci74</td><td>0.0 - 111.4</td></tr>
</table></div>`;

test('parseYearByYear pulls records, champion, standings and weekly results', () => {
  const parsed = parseYearByYear(YBY_HTML, { year: 2015 });

  assert.equal(parsed.champion, 'Anthony Micheletti');
  assert.equal(parsed.records.length, 1, 'the champion row is not a record');
  assert.equal(parsed.records[0].record, 'Most Points Scored, Game');

  // CBS repeats the header mid-table; it must not become a team.
  assert.equal(parsed.teams.length, 2);
  assert.ok(!parsed.teams.some((t) => t.name === 'Team'));
  assert.equal(parsed.teams[0].pointsFor, 1623.1);

  // Week numbers come from the wrapper class, not document order.
  assert.equal(parsed.matchups.length, 2);
  assert.equal(parsed.matchups[0].week, 1);
  assert.deepEqual(
    [parsed.matchups[0].awayScore, parsed.matchups[0].homeScore],
    [81.5, 117.8],
  );
  assert.equal(parsed.matchups[1].week, 15, 'a later week must not be renumbered');
  assert.equal(parsed.matchups[1].bye, true);
  assert.equal(parsed.matchups[1].away, null);
});

// --- champion --------------------------------------------------------------

test('parseChampion ignores selects with nothing actually chosen', () => {
  const html = `
    <table id="table_championship">
      <tr><td>* Number of Champions</td><td><select><option selected>1</option></select></td></tr>
      <tr><td>* Team</td><td><select>
        <option value="Amart">Amart</option>
        <option selected value="Anthony Micheletti">Anthony Micheletti</option>
      </select></td></tr>
      <tr><td>Team</td><td><select>
        <option value="Amart">Amart</option>
        <option value="NY Chaos">NY Chaos</option>
      </select></td></tr>
    </table>`;

  const parsed = parseChampion(html, { year: 2015 });
  assert.equal(parsed.champion, 'Anthony Micheletti');
  // The unset runner-up select would otherwise report whoever sorts first.
  assert.deepEqual(parsed.runnersUp, []);
});

// --- draft -----------------------------------------------------------------

test('parseDraft carries the round forward from the banner row', () => {
  const html = `
    <table class="data borderTop"><tbody>
      <tr class="subtitle"><td colspan="7">Round 1</td></tr>
      <tr class="label"><td>Pick</td><td>Team</td><td>Player</td><td>Elig</td>
          <td>Elapsed Time</td><td>Total Fpts</td><td>Active Fpts</td></tr>
      <tr class="row1"><td>1</td><td>Bryan's Ballers</td><td>Adrian Peterson RB •</td>
          <td></td><td></td><td>234.5</td><td>217.9</td></tr>
      <tr class="row2"><td>2</td><td>Team Of Stars</td><td>Le'Veon Bell RB •</td>
          <td></td><td>55 sec</td><td>87.2</td><td>87.2</td></tr>
      <tr class="subtitle"><td colspan="7">Round 2</td></tr>
      <tr class="row1"><td>15</td><td>NY Chaos</td><td>Julio Jones WR •</td>
          <td></td><td>7 sec</td><td>180.1</td><td>171.0</td></tr>
    </tbody></table>`;

  const { picks } = parseDraft(html, { year: 2015, label: 'Official' });
  assert.equal(picks.length, 3);
  assert.deepEqual(picks[0], {
    round: 1,
    pick: 1,
    team: "Bryan's Ballers",
    player: 'Adrian Peterson',
    position: 'RB',
    elapsed: null,
    totalPoints: 234.5,
    activePoints: 217.9,
  });
  assert.equal(picks[2].round, 2, 'round must carry across the second banner');
  assert.equal(picks[2].pick, 15);
});

test('parseDraft accepts the older Rnd/Pk column name', () => {
  const html = `
    <table><tbody>
      <tr class="label"><td>Rnd/Pk</td><td>Team</td><td>Player</td></tr>
      <tr class="row1"><td>1</td><td>NY Chaos</td><td>Calvin Johnson WR •</td></tr>
    </tbody></table>`;
  const { picks } = parseDraft(html, { year: 2020 });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].pick, 1);
  assert.equal(picks[0].player, 'Calvin Johnson');
});

test('draftUrlInfo reads year and label from either URL form', () => {
  assert.deepEqual(draftUrlInfo('https://x/draft/results/2015:Official:Official'), {
    year: 2015,
    label: 'Official',
  });
  assert.deepEqual(draftUrlInfo('https://x/draft/results/2012'), { year: 2012, label: null });
  assert.equal(draftUrlInfo('https://x/history/standings/2015'), null);
});
