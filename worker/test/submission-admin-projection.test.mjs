import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase } from './helpers/d1.mjs';
import { saveAdminRecord } from '../src/admin-store.ts';

async function fixture() {
  const memory = memoryDatabase(['0001_initial.sql', '0009_admin_record_history.sql', '0012_submission_admin_projection.sql']);
  const { sqlite, adapter } = memory;
  sqlite.exec(`INSERT INTO weeks(id,season,week,phase,status) VALUES(1,2026,3,'REGULAR_SEASON','open');
    INSERT INTO games(id,week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team) VALUES(1,1,0,'game1','2026-09-27T17:00:00Z','BUF','mia',3,'BUF','MIA');
    INSERT INTO players(id,canonical_name) VALUES(1,'Example');
    INSERT INTO submissions(id,week_id,player_id,submitted_name,week_name,best_bet_game_index,tiebreaker,submitted_at) VALUES(1,1,1,'Example','Original',0,400,'2026-09-24T12:00:00.123Z');
    INSERT INTO submission_picks VALUES(1,1,'BUF');`);
  const command = { kind: 'submission', recordId: 'submission:original', operationId: 'source-card-original', expectedVersion: 0, expectedEpoch: 1, reason: 'Source import', body: { name: 'Example', weekName: 'Original', picks: ['BUF'], bestBet: 'BUF', tiebreaker: 400, submittedAt: '2026-09-24T12:00:00.123Z' } };
  await saveAdminRecord(adapter, command, 'source');
  sqlite.exec("INSERT INTO admin_submission_links(record_id,submission_id) VALUES('submission:original',1)");
  return { ...memory, command: { ...command, operationId: 'correct-original-card', expectedVersion: 1, reason: 'Owner correction', body: { ...command.body, name: 'Corrected', weekName: 'None', picks: ['MIA'], bestBet: 'MIA', tiebreaker: 450 } } };
}

test('operational correction is atomic, matchup-specific, ownership-fenced and preserves the real submission time', async () => {
  const { sqlite, adapter, command } = await fixture();
  try {
    await assert.rejects(saveAdminRecord(adapter, command, 'owner'), /fenced/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_events').get().total, 1);
    sqlite.exec("UPDATE admin_control SET owner='D1', epoch=2");
    await saveAdminRecord(adapter, { ...command, expectedEpoch: 2 }, 'owner');
    const row = sqlite.prepare('SELECT * FROM submissions').get();
    assert.equal(row.week_name, 'None'); assert.equal(row.tiebreaker, 450);
    assert.equal(row.submitted_at, '2026-09-24T12:00:00.123Z');
    assert.equal(sqlite.prepare('SELECT picked_team FROM submission_picks').get().picked_team, 'mia');
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submission_corrections').get().total, 1);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('invalid matchups and closed weeks cannot leave partial operational or audit changes', async () => {
  const { sqlite, adapter, command } = await fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1', epoch=2");
    await assert.rejects(saveAdminRecord(adapter, { ...command, expectedEpoch: 2, body: { ...command.body, picks: ['PIT'], bestBet: 'PIT' } }, 'owner'), /slate/);
    sqlite.exec("UPDATE weeks SET status='finalized'");
    await assert.rejects(saveAdminRecord(adapter, { ...command, expectedEpoch: 2 }, 'owner'), /Closed/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_events').get().total, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submission_corrections').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM players').get().total, 1);
  } finally { sqlite.close(); }
});