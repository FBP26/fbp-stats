import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptCompletedArchive } from '../src/completed-history-adapter.ts';

const archive = {
  season: '2026-2027', week: 3, phase: 'REGULAR_SEASON', actualTiebreaker: 388,
  games: [
    { gameIndex: 0, gameId: 'game-1', kickoff: '2026-09-24T20:15:00Z', favorite: 'BUF', underdog: 'mia', spread: 3, homeTeam: 'BUF', awayTeam: 'mia', state: 'FINAL', favoriteScore: 24, underdogScore: 16 },
    { gameIndex: 1, gameId: 'game-2', kickoff: '2026-09-27T17:00:00Z', favorite: 'GB', underdog: 'atl', spread: 6, homeTeam: 'GB', awayTeam: 'atl', state: 'FINAL', favoriteScore: 14, underdogScore: 20 },
  ],
  submissions: [{ name: 'Example', picks: ['BUF', 'atl'], bestBet: 'atl', tiebreaker: 400 }],
};

test('completed archive adapter emits normalized games and scored pick rows', () => {
  const result = adaptCompletedArchive(archive);
  assert.equal(result.games.length, 2);
  assert.equal(result.games[0].gameId, '2026-2027|3|1');
  assert.deepEqual(result.picks.map(row => row.result), ['win', 'win']);
  assert.equal(result.picks[1].bestBetWin, 1);
  assert.equal(result.picks[0].bestBetResult, null);
});

test('completed archive adapter accepts the immutable completed-CSV archive shape', () => {
  const imported = {
    ...archive,
    games: archive.games.map(({ gameIndex, kickoff, homeTeam, awayTeam, state, ...game }, index) => ({ ...game, gameDate: ['9/24/2026', '9/27/2026'][index], kickoff: '2026-09-25T00:15:00Z', home: homeTeam, away: awayTeam, status: state })),
  };
  const result = adaptCompletedArchive(imported);
  assert.equal(result.games[0].gameDate, '2026-09-24');
  assert.deepEqual(result.picks.map(row => row.result), ['win', 'win']);
});

test('completed archive adapter fails closed for incomplete final evidence', () => {
  assert.throws(() => adaptCompletedArchive({ ...archive, games: [{ ...archive.games[0], state: 'LIVE' }] }), /final games/);
  assert.throws(() => adaptCompletedArchive({ ...archive, submissions: [{ ...archive.submissions[0], picks: ['BUF'] }] }), /one pick/);
});