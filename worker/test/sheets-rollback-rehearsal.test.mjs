import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetsRollbackPlan, rehearseSheetsRollback } from '../scripts/sheets-rollback-rehearsal.mjs';

const headers = ['submittedAt', 'season', 'week', 'name', 'weekName']
  .concat(Array.from({ length: 16 }, (_, index) => `Game ${index + 1}`), ['Best Bet', 'Tiebreaker', 'source', 'browserId']);
const picks = Array.from({ length: 16 }, (_, index) => index % 2 ? 'MIA' : 'BUF');

function source(rows = []) {
  return { version: 1, workbookId: 'disposable-workbook', timeZone: 'America/New_York', documents: [{ title: 'website submissions', sheetId: 1,
    values: [headers, ...rows], formulas: [headers, ...rows.map(row => row.map(value => String(value)))], display: [headers, ...rows.map(row => row.map(value => String(value)))],
  }] };
}

function checkpoint() {
  return { payload: { tables: {
    weeks: [{ id: 1, season: 2026, week: 3, phase: 'REGULAR_SEASON' }],
    games: Array.from({ length: 16 }, (_, index) => ({ id: index + 1, week_id: 1, game_index: index })),
    players: [{ id: 1, canonical_name: 'Example' }],
    submissions: [{ id: 1, week_id: 1, player_id: 1, submitted_name: 'Example', week_name: 'None', best_bet_game_index: 0, best_bet_team: 'BUF', tiebreaker: 388, source: 'website', submitted_at: '2026-09-24T19:00:00.000Z' }],
    submission_picks: picks.map((picked_team, index) => ({ submission_id: 1, game_id: index + 1, picked_team })),
  } } };
}

test('rollback rehearsal appends only missing D1 cards and is replay-safe', () => {
  const result = rehearseSheetsRollback(checkpoint(), source());
  assert.equal(result.plan.appendedRows, 1);
  assert.equal(result.plan.skippedNonRegular, 0);
  assert.equal(result.replaySafe, true);
  assert.equal(result.productionWrites, 0);
  assert.equal(result.restoredSnapshot.documents[0].values.length, 2);
  assert.equal(result.restoredSnapshot.documents[0].values[1][3], 'Example');
});

test('rollback planning refuses to overwrite a conflicting original Sheets row', () => {
  const baseline = rehearseSheetsRollback(checkpoint(), source()).restoredSnapshot;
  baseline.documents[0].values[1][5] = 'MIA';
  assert.throws(() => buildSheetsRollbackPlan(checkpoint(), baseline), /rollback conflict/);
});

test('rollback planning preserves legacy source and browser metadata for an existing card', () => {
  const baseline = rehearseSheetsRollback(checkpoint(), source()).restoredSnapshot;
  baseline.documents[0].values[1][23] = 'website';
  baseline.documents[0].values[1][24] = 'legacy-browser';
  assert.equal(buildSheetsRollbackPlan(checkpoint(), baseline).appendedRows, 0);
});

test('rollback planning preserves unchanged source originals and blocks corrected originals', () => {
  const sourceCheckpoint = checkpoint();
  sourceCheckpoint.payload.tables.submissions[0].source = 'source-original';
  assert.equal(buildSheetsRollbackPlan(sourceCheckpoint, source()).skippedSourceOriginals, 1);
  sourceCheckpoint.payload.tables.submission_corrections = [{ submission_id: 1 }];
  assert.throws(() => buildSheetsRollbackPlan(sourceCheckpoint, source()), /requires explicit reconciliation/);
});