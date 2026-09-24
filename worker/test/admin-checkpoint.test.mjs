import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminCheckpoint, restoreAdminCheckpoint } from '../scripts/admin-checkpoint.mjs';
import { saveAdminRecord } from '../src/admin-store.ts';
import { memoryDatabase } from './helpers/d1.mjs';

test('recovery preserves intervening edits and their history while fencing old ownership epochs', async () => {
  const source = memoryDatabase(['0009_admin_record_history.sql']);
  const recovery = memoryDatabase(['0009_admin_record_history.sql']);
  try {
    const command = { kind: 'payout', recordId: 'payout:example', operationId: 'initial-payout-record', expectedVersion: 0, expectedEpoch: 1, reason: 'Original import', body: { balance: '20' } };
    await saveAdminRecord(source.adapter, command, 'owner');
    source.sqlite.exec("UPDATE admin_control SET owner = 'D1', epoch = 2");
    await saveAdminRecord(source.adapter, { ...command, operationId: 'intervening-payment', expectedVersion: 1, expectedEpoch: 2, reason: 'Payment', body: { balance: 'even' } }, 'owner');
    const checkpoint = await createAdminCheckpoint(source.adapter);
    const corrupted = structuredClone(checkpoint); corrupted.payload.records[0].body = '{}';
    await assert.rejects(restoreAdminCheckpoint(recovery.adapter, corrupted), /checksum/);
    assert.deepEqual(await restoreAdminCheckpoint(recovery.adapter, checkpoint), { records: 1, events: 2, epoch: 3 });
    assert.equal(JSON.parse(recovery.sqlite.prepare('SELECT body FROM admin_records').get().body).balance, 'even');
    await assert.rejects(saveAdminRecord(recovery.adapter, { ...command, operationId: 'stale-after-rollback', expectedVersion: 2, expectedEpoch: 2 }, 'owner'), /changed/);
    await assert.rejects(restoreAdminCheckpoint(recovery.adapter, checkpoint), /empty/);
    assert.deepEqual(recovery.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { source.sqlite.close(); recovery.sqlite.close(); }
});