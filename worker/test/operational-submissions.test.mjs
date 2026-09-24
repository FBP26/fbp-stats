import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from './helpers/d1.mjs';
import { submitOperationalCard } from '../src/operational-submissions.ts';
import worker from '../src/index.ts';
import { saveAdminRecord } from '../src/admin-store.ts';

const command = { operationId: 'submission-fixture-0001', name: 'Example', weekName: 'None', season: 2026, week: 3, picks: ['mia'], bestBet: 'MIA', tiebreaker: 0 };
function fixture() {
  const memory = memoryDatabase(['0001_initial.sql', '0009_admin_record_history.sql', '0012_submission_admin_projection.sql', '0013_operational_receipts.sql']);
  memory.sqlite.exec(`INSERT INTO weeks(id,season,week,phase,status) VALUES(1,2026,3,'REGULAR_SEASON','open');
    INSERT INTO games(id,week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team) VALUES(1,1,0,'game1','2026-09-27T17:00:00Z','BUF','mia',3,'BUF','MIA');`);
  return memory;
}

test('submissions fail closed under Sheets ownership; D1 writes and retries preserve one original card', async () => {
  const { sqlite, adapter } = fixture();
  try {
    await assert.rejects(submitOperationalCard(adapter, command), /Sheets currently owns/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM players').get().total, 0);
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const result = await submitOperationalCard(adapter, command, '2026-09-24T19:00:00.123Z');
    assert.equal(result.submittedAt, '2026-09-24T19:00:00.123Z');
    assert.equal((await submitOperationalCard(adapter, command)).replayed, true);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 1);
    assert.equal(sqlite.prepare('SELECT picked_team FROM submission_picks').get().picked_team, 'mia');
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_submission_links').get().total, 1);
    const body = JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body);
    await saveAdminRecord(adapter, { kind: 'submission', recordId: 'operational:submission-fixture-0001', expectedVersion: 1, expectedEpoch: 2,
      operationId: 'owner-correction-0001', reason: 'Correct entered week name', body: { ...body, weekName: 'Corrected' } }, 'owner');
    assert.equal(sqlite.prepare('SELECT week_name FROM submissions').get().week_name, 'Corrected');
    await assert.rejects(submitOperationalCard(adapter, { ...command, tiebreaker: 1 }), /reused/);
    await assert.rejects(submitOperationalCard(adapter, { ...command, operationId: 'submission-fixture-0002', tiebreaker: '' }), /numeric tiebreaker/);
  } finally { sqlite.close(); }
});

test('new late entrants are accepted, replacements lock at kickoff, stale and failed writes preserve prior cards', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    await submitOperationalCard(adapter, command, '2026-09-24T19:00:00Z');
    const next = { ...command, operationId: 'submission-fixture-0002', expectedSubmissionId: 1, tiebreaker: 400 };
    await assert.rejects(submitOperationalCard(adapter, next, '2026-09-27T17:00:00Z'), /first kickoff/);
    await submitOperationalCard(adapter, { ...command, name: 'Late New', operationId: 'submission-fixture-0003' }, '2026-09-27T18:00:00Z');
    await assert.rejects(submitOperationalCard(adapter, { ...next, expectedSubmissionId: null }, '2026-09-24T20:00:00Z'), /current card changed/);
    sqlite.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON submission_picks WHEN NEW.submission_id > 2 BEGIN SELECT RAISE(ABORT,'forced pick failure'); END;");
    await assert.rejects(submitOperationalCard(adapter, next, '2026-09-24T20:00:00Z'), /forced pick failure/);
    assert.equal(sqlite.prepare('SELECT superseded_at FROM submissions WHERE id=1').get().superseded_at, null);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM operational_receipts').get().total, 2);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('replacement validation matches live limits and timestamp collisions preserve the original for retry', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    await assert.rejects(submitOperationalCard(adapter, { ...command, name: 'A'.repeat(14) }), /Invalid name/);
    await assert.rejects(submitOperationalCard(adapter, { ...command, weekName: 'A'.repeat(256) }), /Invalid name/);
    for (const tiebreaker of ['400.1234', '4e2', true, '']) {
      await assert.rejects(submitOperationalCard(adapter, { ...command, tiebreaker }), /numeric tiebreaker/);
    }
    const original = { ...command, name: 'A'.repeat(13), weekName: 'A'.repeat(255), tiebreaker: '400.123' };
    await submitOperationalCard(adapter, original, '2026-09-24T19:00:00.123Z');
    const replacement = { ...original, operationId: 'submission-fixture-0002', expectedSubmissionId: 1, picks: ['BUF'], bestBet: 'BUF' };
    await assert.rejects(submitOperationalCard(adapter, replacement, '2026-09-24T19:00:00.123Z'), /UNIQUE constraint/);
    assert.equal(sqlite.prepare('SELECT superseded_at FROM submissions WHERE id=1').get().superseded_at, null);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM operational_receipts').get().total, 1);
    await submitOperationalCard(adapter, replacement, '2026-09-24T19:00:00.124Z');
    assert.deepEqual(sqlite.prepare('SELECT picked_team FROM submission_picks ORDER BY submission_id').all().map(row => row.picked_team), ['mia', 'BUF']);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions WHERE superseded_at IS NULL').get().total, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_submission_links').get().total, 2);
  } finally { sqlite.close(); }
});

test('the public Worker route rejects writes while Sheets owns the pool', async () => {
  const { sqlite, adapter } = fixture();
  try {
    const response = await worker.fetch(new Request('https://example.test/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }), { DB: adapter, CORS_ORIGIN: '*' });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /Sheets currently owns/);
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const disabled = await worker.fetch(new Request('https://example.test/', { method: 'POST', body: JSON.stringify(command) }), { DB: adapter, CORS_ORIGIN: '*' });
    assert.equal(disabled.status, 409);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
  } finally { sqlite.close(); }
});

test('public corrections cannot bypass the private editor under either owner', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const receipt = await submitOperationalCard(adapter, command, '2026-09-24T19:00:00Z');
    for (const owner of ['D1', 'SHEETS']) {
      sqlite.prepare('UPDATE admin_control SET owner=?').run(owner);
      const response = await worker.fetch(new Request('https://example.test/', { method: 'POST', body: JSON.stringify({
        action: 'correct-submission-name', originalName: command.name, correctedName: 'Changed', correctedWeekName: 'Changed',
        submittedAt: receipt.submittedAt, season: command.season, week: command.week,
      }) }), { DB: adapter, CORS_ORIGIN: '*', OPERATIONAL_WRITES_ENABLED: 'true' });
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /private owner editor/);
    }
    assert.equal(sqlite.prepare('SELECT week_name FROM submissions').get().week_name, command.weekName);
    assert.equal(sqlite.prepare('SELECT canonical_name FROM players').get().canonical_name, command.name);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submission_corrections').get().total, 0);
  } finally { sqlite.close(); }
});

test('an ownership transition between validation and commit fences the entire transaction', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const changing = { ...adapter, batch: async statements => {
      sqlite.exec("UPDATE admin_control SET owner='SHEETS',epoch=3");
      return adapter.batch(statements);
    } };
    await assert.rejects(submitOperationalCard(changing, command, '2026-09-24T19:00:00Z'), /ownership changed/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM players').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM operational_receipts').get().total, 0);
  } finally { sqlite.close(); }
});

test('a slate change during validation cannot accept picks against the wrong games', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const changing = { ...adapter, batch: async statements => {
      sqlite.exec("UPDATE games SET underdog='pit'");
      return adapter.batch(statements);
    } };
    await assert.rejects(submitOperationalCard(changing, command, '2026-09-24T19:00:00Z'), /changed during submission/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_records').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
  } finally { sqlite.close(); }
});