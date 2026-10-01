import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompletedHistoryParity } from '../scripts/verify-completed-history-parity.mjs';

const headers = 'Season,Week,Game Num,Game Date,Game Day,Game Time,Favorite,Spread,Underdog,Home,Away,Name,Week Name,Pick,Best Bet,Win ATS,Loss ATS,Push,Fav Score,Und Score,Home Score,Away Score,Winner ATS Score,Loser ATS Score,Pick Score,Against Pick Score,BB Score,BB Score Against,Margin of Victory,Picked Against,Best Bet Against,Fav/Und,Home/Away,Result,BB Result,Result Win,Result Loss,Result Push,BB Win,BB Loss,BB Push,Tiebreaker,Actual Tiebreak,Tiebreaker Diff,Playoff Game Num,Round';
const row = '2026-2027,3,1,9/24/2026,Thu,8:15 PM,BUF,3,mia,BUF,mia,Example,Quick picks,BUF,BUF,BUF,mia,,24,16,24,16,24,16,,,,8,,,,Fav,Home,win,win,1,0,0,1,0,0,400,388,12,,';
const archive = {
  seasonStart: 2026, week: 3, phase: 'REGULAR_SEASON', actualTiebreaker: 388,
  games: [{ gameIndex: 0, gameId: 'game-1', kickoff: '2026-09-24T20:15:00Z', favorite: 'BUF', underdog: 'mia', spread: 3, homeTeam: 'BUF', awayTeam: 'mia', state: 'FINAL', favoriteScore: 24, underdogScore: 16 }],
  submissions: [{ name: 'Example', picks: ['BUF'], bestBet: 'BUF', tiebreaker: 400 }],
};

test('completed archive projection matches canonical completed CSV semantics', () => {
  assert.deepEqual(assertCompletedHistoryParity(archive, `${headers}\n${row}\n`), { ok: true, games: 1, picks: 1 });
});

test('completed archive parity treats player display casing as the same identity', () => {
  const casingVariant = { ...archive, submissions: [{ ...archive.submissions[0], name: 'eXaMpLe' }] };
  assert.deepEqual(assertCompletedHistoryParity(casingVariant, `${headers}\n${row}\n`), { ok: true, games: 1, picks: 1 });
});

test('completed archive parity fails closed on canonical score mismatch', () => {
  assert.throws(() => assertCompletedHistoryParity(archive, `${headers}\n${row.replace(',24,16,24,16,24,16,', ',24,16,23,16,24,16,')}\n`), /field homeScore/);
});