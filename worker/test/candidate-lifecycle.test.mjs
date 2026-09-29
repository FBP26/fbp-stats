import test from 'node:test';
import assert from 'node:assert/strict';
import { recordCandidateObservation, replacementSubmissionAllowed, playoffPicksVisible } from '../src/candidate-lifecycle.ts';
import { memoryDatabase } from './helpers/d1.mjs';
import { compareCandidateArchive } from '../scripts/candidate-parity.mjs';

const kickoff = Date.parse('2026-09-27T17:00:00Z');
function observation({ phase = 'REGULAR_SEASON', week = 3, count = 1, status = 'PREGAME', actual = null } = {}) {
  const games = Array.from({ length: count }, (_, index) => ({ gameId: `game-${index}`, kickoff: new Date(kickoff).toISOString(), favorite: `F${index}`, underdog: `U${index}`, spread: 3, status, favoriteScore: status === 'PREGAME' ? null : 20, underdogScore: status === 'PREGAME' ? null : 10, clock: '', period: '' }));
  return { season: 2026, week, phase, staged: true, feed: { games, cards: [{ name: 'Example', weekName: 'None', picks: games.map(game => game.favorite), bestBet: games[0].favorite, tiebreaker: 400 }] }, actualTiebreaker: actual, tiebreakFinal: actual !== null };
}

test('candidate lifecycle records independent race frames and immutable finals without early score completion', async () => {
  const { sqlite, adapter } = memoryDatabase(['0010_candidate_lifecycle.sql']);
  try {
    await recordCandidateObservation(adapter, observation(), kickoff - 600000);
    await recordCandidateObservation(adapter, observation({ status: 'LIVE' }), kickoff + 600000);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM candidate_archives').get().total, 0);
    const frame = JSON.parse(sqlite.prepare('SELECT payload_json FROM candidate_race_frames ORDER BY observed_at DESC LIMIT 1').get().payload_json);
    assert.equal(frame.outcomeCount, 3);
    await recordCandidateObservation(adapter, observation({ status: 'FINAL' }), kickoff + 1200000);
    assert.equal(sqlite.prepare('SELECT status FROM candidate_weeks').get().status, 'finalizing');
    await recordCandidateObservation(adapter, observation({ status: 'FINAL', actual: 410 }), kickoff + 1800000);
    const week = sqlite.prepare('SELECT * FROM candidate_weeks').get();
    assert.equal(week.status, 'finalized'); assert.equal(week.observed_open, 1); assert.equal(week.observed_live, 1);
    const archive = sqlite.prepare('SELECT * FROM candidate_archives').get();
    assert.equal(JSON.parse(archive.payload_json).results[0].wins, 2);
    await recordCandidateObservation(adapter, observation({ status: 'FINAL', actual: 410 }), kickoff + 2400000);
    await assert.rejects(recordCandidateObservation(adapter, observation({ status: 'FINAL', actual: 411 }), kickoff + 3000000), /immutable/);
    assert.throws(() => sqlite.exec('DELETE FROM candidate_archives'), /immutable/);
    assert.equal(sqlite.prepare('SELECT checksum FROM candidate_archives').get().checksum, archive.checksum);
  } finally { sqlite.close(); }
});

test('final archive comparison rejects incomplete, corrupt and mismatched evidence without claiming cutover readiness', async () => {
  const { sqlite, adapter } = memoryDatabase(['0010_candidate_lifecycle.sql']);
  try {
    await recordCandidateObservation(adapter, observation({ status: 'FINAL', actual: 410 }), kickoff + 1800000);
    const stored = sqlite.prepare('SELECT * FROM candidate_archives').get();
    const candidate = JSON.parse(stored.payload_json);
    const canonical = { ok: true, season: 2026, week: 3, tiebreakStatus: 'final', actualTiebreaker: 410, games: candidate.games, players: candidate.results };
    const report = compareCandidateArchive(stored, canonical);
    assert.equal(report.finalResultParity, true);
    assert.equal(report.fullReplacementReady, false);
    assert.equal(report.productionWrites, 0);
    assert.throws(() => compareCandidateArchive(null, canonical), /not finalized/);
    assert.throws(() => compareCandidateArchive({ ...stored, checksum: 'bad' }, canonical), /checksum/);
    for (const change of [
      value => { value.week = 4; },
      value => { value.actualTiebreaker = ''; },
      value => { value.actualTiebreaker = 411; },
      value => { value.tiebreakStatus = ''; },
      value => { value.games[0].status = 'LIVE'; },
      value => { value.games[0].favoriteScore++; },
      value => { value.players[0].picks[0] = 'U0'; value.players[0].bestBet = 'U0'; },
      value => { value.players[0].weekName = 'Changed'; },
      value => { value.players[0].wins++; },
      value => { value.players = []; },
    ]) {
      const changed = structuredClone(canonical);
      change(changed);
      assert.throws(() => compareCandidateArchive(stored, changed));
    }
  } finally { sqlite.close(); }
});

test('all four playoff rounds require prior finalization and Super Bowl is one doubled pick', async () => {
  const { sqlite, adapter } = memoryDatabase(['0010_candidate_lifecycle.sql']);
  try {
    await assert.rejects(recordCandidateObservation(adapter, observation({ phase: 'PLAYOFFS', week: 2, count: 4 }), kickoff - 1000), /previous/);
    for (const [index, count] of [6, 4, 2, 1].entries()) {
      const week = index + 1;
      await recordCandidateObservation(adapter, observation({ phase: 'PLAYOFFS', week, count }), kickoff - 600000);
      await recordCandidateObservation(adapter, observation({ phase: 'PLAYOFFS', week, count, status: 'LIVE' }), kickoff + 600000);
      await recordCandidateObservation(adapter, observation({ phase: 'PLAYOFFS', week, count, status: 'FINAL', actual: week === 4 ? 400 : null }), kickoff + 1200000);
      const archive = JSON.parse(sqlite.prepare("SELECT payload_json FROM candidate_archives WHERE phase = 'PLAYOFFS' AND week = ?").get(week).payload_json);
      assert.equal(archive.results[0].wins, count + 1);
      assert.equal(archive.games.length, count);
    }
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM candidate_archives').get().total, 4);
  } finally { sqlite.close(); }
});

test('stale reads, changed slates, invalid cards, unapproved staging and failed transactions cannot corrupt candidate history', async () => {
  const { sqlite, adapter } = memoryDatabase(['0010_candidate_lifecycle.sql']);
  try {
    await assert.rejects(recordCandidateObservation(adapter, { ...observation(), staged: false }, kickoff - 600000), /staged/);
    await recordCandidateObservation(adapter, observation(), kickoff - 600000);
    const altered = observation(); altered.feed.games[0].spread = 4;
    await assert.rejects(recordCandidateObservation(adapter, altered, kickoff - 500000), /slate changed/);
    await recordCandidateObservation(adapter, altered, kickoff - 700000);
    sqlite.exec("CREATE TRIGGER reject_frame BEFORE INSERT ON candidate_race_frames BEGIN SELECT RAISE(ABORT, 'forced frame failure'); END");
    await assert.rejects(recordCandidateObservation(adapter, observation({ status: 'LIVE' }), kickoff + 600000), /forced frame/);
    assert.equal(sqlite.prepare('SELECT status FROM candidate_weeks').get().status, 'open');
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('submission deadline and playoff reveal rules preserve the existing late-new-player exception', () => {
  assert.equal(replacementSubmissionAllowed(true, kickoff, kickoff - 1, 'open'), true);
  assert.equal(replacementSubmissionAllowed(true, kickoff, kickoff, 'live'), false);
  assert.equal(replacementSubmissionAllowed(false, kickoff, kickoff + 1, 'live'), true);
  assert.equal(replacementSubmissionAllowed(false, kickoff, kickoff + 1, 'finalized'), false);
  const cards = observation().feed.cards;
  assert.equal(playoffPicksVisible(cards, ['Example', 'Other'], kickoff, kickoff - 1), false);
  assert.equal(playoffPicksVisible(cards, ['Example'], kickoff, kickoff - 1), true);
  assert.equal(playoffPicksVisible(cards, ['Example', 'Other'], kickoff, kickoff), true);
});

test('candidate archives retain opposing legacy Best Bets without rewriting the ordinary pick', async () => {
  const { sqlite, adapter } = memoryDatabase(['0010_candidate_lifecycle.sql']);
  try {
    const legacy = observation({ status: 'FINAL', actual: 410 });
    legacy.feed.cards[0].bestBet = 'U0';
    await recordCandidateObservation(adapter, legacy, kickoff + 1800000);
    const archive = JSON.parse(sqlite.prepare('SELECT payload_json FROM candidate_archives').get().payload_json);
    assert.deepEqual(archive.cards[0].picks, ['F0']);
    assert.equal(archive.cards[0].bestBet, 'U0');
    assert.equal(archive.results[0].wins, 1);
    assert.equal(archive.results[0].losses, 1);
  } finally { sqlite.close(); }
});