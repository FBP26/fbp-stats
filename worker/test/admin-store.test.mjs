import assert from 'node:assert/strict';
import test from 'node:test';
import { saveAdminRecord } from '../src/admin-store.ts';
import { memoryDatabase } from './helpers/d1.mjs';

const command = (overrides = {}) => ({
  operationId: 'operation-create-0001', kind: 'submission', recordId: 'submission-1',
  expectedVersion: 0, expectedEpoch: 1, reason: 'Original ledger import',
  body: { submittedAt: '2026-09-24T12:01:02.345Z', weekName: 'None', picks: ['BUF'] }, ...overrides,
});

test('admin records preserve source values, reject stale edits, and replay accepted operations without duplication', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql']);
  try {
    const first = command();
    assert.deepEqual(await saveAdminRecord(adapter, first, 'owner'), { version: 1, replayed: false });
    assert.deepEqual(await saveAdminRecord(adapter, first, 'owner'), { version: 1, replayed: true });
    const correction = command({ operationId: 'operation-correct-0002', expectedVersion: 1, reason: 'Fix week name', body: { ...first.body, weekName: 'Corrected' } });
    await saveAdminRecord(adapter, correction, 'owner');
    await assert.rejects(saveAdminRecord(adapter, command({ operationId: 'operation-stale-0003', expectedVersion: 1 }), 'owner'), /changed/);
    await assert.rejects(saveAdminRecord(adapter, { ...first, body: { picks: ['MIA'] } }, 'owner'), /different content/);
    await saveAdminRecord(adapter, first, 'owner');
    assert.equal(sqlite.prepare('SELECT version FROM admin_records').get().version, 2);
    const history = sqlite.prepare('SELECT body, actor, reason FROM admin_events ORDER BY version').all();
    assert.equal(history.length, 2);
    assert.deepEqual(JSON.parse(history[0].body), first.body);
    assert.equal(JSON.parse(history[1].body).submittedAt, first.body.submittedAt);
    assert.equal(history[1].reason, 'Fix week name');
    assert.throws(() => sqlite.exec('DELETE FROM admin_events'), /immutable/);
    assert.throws(() => sqlite.exec("UPDATE admin_events SET reason = 'replaced'"), /immutable/);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('ownership epoch fences old requests and immutable source ledgers cannot be edited', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql']);
  try {
    const source = command({ kind: 'source-ledger' });
    await saveAdminRecord(adapter, source, 'owner');
    await assert.rejects(saveAdminRecord(adapter, command({ kind: 'source-ledger', operationId: 'operation-edit-ledger', expectedVersion: 1 }), 'owner'), /changed/);
    sqlite.exec("UPDATE admin_control SET owner = 'D1', epoch = 2");
    await assert.rejects(saveAdminRecord(adapter, command({ operationId: 'operation-old-epoch' }), 'owner'), /changed/);
    await saveAdminRecord(adapter, command({ operationId: 'operation-new-epoch', expectedEpoch: 2 }), 'owner');
    sqlite.exec("UPDATE admin_control SET owner = 'SHEETS', epoch = 3");
    await assert.rejects(saveAdminRecord(adapter, command({ operationId: 'operation-after-rollback', expectedEpoch: 2, expectedVersion: 1 }), 'owner'), /changed/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_events').get().total, 2);
  } finally { sqlite.close(); }
});

test('failed current-record writes roll back the entire audit event', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql']);
  try {
    sqlite.exec("CREATE TRIGGER reject_record BEFORE INSERT ON admin_records BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    await assert.rejects(saveAdminRecord(adapter, command(), 'owner'), /forced failure/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_events').get().total, 0);
  } finally { sqlite.close(); }
});