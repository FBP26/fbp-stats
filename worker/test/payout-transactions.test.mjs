import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from './helpers/d1.mjs';
import { saveAdminRecord } from '../src/admin-store.ts';
import { moneyCents, payoutBalanceCents, postPayoutTransaction } from '../scripts/payout-transactions.mjs';
import { createAdminCheckpoint, restoreAdminCheckpoint } from '../scripts/admin-checkpoint.mjs';

const command = (overrides = {}) => ({ recordId: 'payout:example', operationId: 'accept-baseline-operation', expectedVersion: 1, expectedEpoch: 1, type: 'ADOPT_PAYOUT_BASELINE', reason: 'Preserve the existing Payout balance', ...overrides });

test('accepted source balance, payments, payouts, adjustments and retries have one atomic journal', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
  try {
    await saveAdminRecord(adapter, { ...command(), kind: 'payout', expectedVersion: 0, operationId: 'import-source-balance', body: { name: 'Example', season: '2026', balance: '20', reconciliation: { status: 'mismatch', ledgerBalance: 220 } } }, 'source');
    await postPayoutTransaction(adapter, command(), 'owner');
    const payment = command({ type: 'PAYMENT_RECEIVED', amount: '30.25', expectedVersion: 2, operationId: 'receive-payment-01', reason: 'Received payment' });
    await postPayoutTransaction(adapter, payment, 'owner');
    await postPayoutTransaction(adapter, command({ type: 'CASH_PAID_OUT', amount: '5', expectedVersion: 3, operationId: 'return-cash-credit-01' }), 'owner');
    assert.equal((await postPayoutTransaction(adapter, payment, 'owner')).replayed, true);
    const record = JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body);
    assert.equal(record.balance, '+5.25');
    assert.equal(record.balanceCents, -525);
    assert.equal(record.reconciliation.ledgerBalance, 220);
    assert.equal(record.reconciliation.status, 'accepted-payout-baseline');
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM payout_journal').get().total, 3);
    const recovery = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
    try {
      const checkpoint = await createAdminCheckpoint(adapter);
      await restoreAdminCheckpoint(recovery.adapter, checkpoint);
      assert.deepEqual(recovery.sqlite.prepare('SELECT * FROM payout_journal ORDER BY version').all(), sqlite.prepare('SELECT * FROM payout_journal ORDER BY version').all());
    } finally { recovery.sqlite.close(); }
    await assert.rejects(postPayoutTransaction(adapter, { ...payment, operationId: 'stale-payment-request' }, 'owner'), /changed/);
    await assert.rejects(saveAdminRecord(adapter, { ...command(), kind: 'payout', expectedVersion: 4, operationId: 'unaudited-balance-edit', body: { ...record, balance: '999', balanceCents: 99900 } }, 'owner'), /audited posting/);
    sqlite.exec("CREATE TRIGGER reject_posting BEFORE INSERT ON payout_journal BEGIN SELECT RAISE(ABORT, 'forced journal failure'); END");
    await assert.rejects(postPayoutTransaction(adapter, command({ type: 'PRIZE_PAID', amount: '10', expectedVersion: 4, operationId: 'rejected-prize-payout' }), 'owner'), /forced journal/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_events').get().total, 4);
    assert.throws(() => sqlite.exec('DELETE FROM payout_journal'), /immutable/);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('money conversion uses exact cents and preserves the existing credit convention', () => {
  assert.equal(moneyCents('0.01'), 1);
  assert.equal(moneyCents('20.50'), 2050);
  assert.equal(payoutBalanceCents('+10'), -1000);
  assert.equal(payoutBalanceCents('20'), 2000);
  assert.equal(payoutBalanceCents('even'), 0);
  assert.throws(() => moneyCents('0.001'), /Invalid/);
  assert.throws(() => moneyCents('-10'), /Invalid/);
});