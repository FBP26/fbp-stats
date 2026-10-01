import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from './helpers/d1.mjs';
import { saveAdminRecord } from '../src/admin-store.ts';
import { moneyCents, payoutBalanceCents, postPayoutTransaction, planPayoutBaselineAdoptions, allocatePayoutPeriods, settlePayoutCredit, planWeeklyAward } from '../scripts/payout-transactions.mjs';
import { createAdminCheckpoint, restoreAdminCheckpoint } from '../scripts/admin-checkpoint.mjs';
import { readOperationalPayouts } from '../src/payouts.ts';

const command = (overrides = {}) => ({ recordId: 'payout:example', operationId: 'accept-baseline-operation', expectedVersion: 1, expectedEpoch: 1, type: 'ADOPT_PAYOUT_BASELINE', reason: 'Preserve the existing Payout balance', ...overrides });

test('accepted source balance, payments, payouts, adjustments and retries have one atomic journal', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
  try {
    await saveAdminRecord(adapter, { ...command(), kind: 'payout', expectedVersion: 0, operationId: 'import-source-balance', body: { name: 'Example', season: '2026', balance: '20', periods: [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'], weeks: Array(19).fill('paid'), reconciliation: { status: 'mismatch', ledgerBalance: 220 } } }, 'source');
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

test('public payout projection requires ownership and accepted cents, preserves periods and strips private fields', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
  try {
    await assert.rejects(readOperationalPayouts(adapter), /Sheets currently owns/);
    const body = { name: 'Example', season: '2026', periods: Array.from({ length: 19 }, (_, index) => String(index + 1)), weeks: Array(19).fill('paid'), balance: '+210', notes: 'private', provenance: { private: true } };
    await saveAdminRecord(adapter, { ...command(), kind: 'payout', expectedVersion: 0, operationId: 'import-payout-reader', body }, 'source');
    sqlite.exec("UPDATE admin_control SET owner='D1'");
    await assert.rejects(readOperationalPayouts(adapter), /baseline has not been accepted/);
    await postPayoutTransaction(adapter, command(), 'owner');
    const result = await readOperationalPayouts(adapter);
    assert.equal(result.seasons[0].season, '2026-2027');
    assert.deepEqual(result.seasons[0].players, [{ name: 'Example', weeks: Array(19).fill('paid'), balance: '+210' }]);
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(JSON.stringify(result).includes('posting'), false);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM payout_journal').get().total, 1);
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

test('prepaid allocation atomically covers future fees without erasing wins or moving cash', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
  try {
    const periods = [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'];
    const weeks = [...Array(10).fill('paid'), ...Array(9).fill('')];
    weeks[2] = 'win';
    await saveAdminRecord(adapter, { ...command(), kind: 'payout', expectedVersion: 0, operationId: 'import-allocation-source', body: { name: 'Example', season: '2026', periods, weeks, balance: '+290' } }, 'source');
    await postPayoutTransaction(adapter, command(), 'owner');
    const allocation = command({ type: 'PREPAID_ALLOCATION', amount: '100', periods: periods.slice(10), expectedVersion: 2, operationId: 'allocate-future-periods' });
    await assert.rejects(postPayoutTransaction(adapter, { ...allocation, amount: '90' }, 'owner'), /amount must match/);
    await assert.rejects(postPayoutTransaction(adapter, { ...allocation, periods: ['11', '11'] }, 'owner'), /distinct/);
    await assert.rejects(postPayoutTransaction(adapter, { ...allocation, periods: ['3'] }, 'owner'), /blank/);
    sqlite.exec("CREATE TRIGGER reject_allocation BEFORE INSERT ON payout_journal WHEN NEW.transaction_type = 'PREPAID_ALLOCATION' BEGIN SELECT RAISE(ABORT, 'forced allocation failure'); END");
    await assert.rejects(postPayoutTransaction(adapter, allocation, 'owner'), /forced allocation failure/);
    assert.deepEqual(JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body).weeks, weeks);
    sqlite.exec('DROP TRIGGER reject_allocation');
    await postPayoutTransaction(adapter, allocation, 'owner');
    assert.equal((await postPayoutTransaction(adapter, allocation, 'owner')).replayed, true);
    const record = JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body);
    assert.equal(record.balance, '+190');
    assert.equal(record.weeks[2], 'win');
    assert.equal(record.weeks.filter(value => value === 'paid').length, 18);
    const journal = sqlite.prepare("SELECT * FROM payout_journal WHERE transaction_type = 'PREPAID_ALLOCATION'").all();
    assert.equal(journal.length, 1);
    assert.equal(journal[0].money_in_cents, 0);
    assert.equal(journal[0].money_out_cents, 0);
    assert.equal(journal[0].after_cents - journal[0].before_cents, 10000);
    await assert.rejects(postPayoutTransaction(adapter, { ...allocation, expectedVersion: 3, operationId: 'duplicate-period-allocation' }, 'owner'), /blank/);
  } finally { sqlite.close(); }
});

test('baseline plans preserve carried debt, reject changed evidence and never repost accepted balances', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
  try {
    const periods = [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'];
    const body = { name: 'Example', season: '2026', periods, weeks: ['10', '10', ...Array(17).fill('')], balance: '170', reconciliation: { status: 'match', ledgerBalance: 170 } };
    const source = [{ kind: 'payout', recordId: 'payout:example', body }, { kind: 'payout', recordId: 'payout:prior', body: { name: 'Example', season: '2025', balance: '150' } }];
    await saveAdminRecord(adapter, { ...command(), kind: 'payout', expectedVersion: 0, operationId: 'import-carried-balance', body }, 'source');
    const stored = () => sqlite.prepare('SELECT * FROM admin_records').all();
    const control = { owner: 'SHEETS', epoch: 1 };
    const plan = planPayoutBaselineAdoptions(source, stored(), control);
    assert.equal(plan.commands.length, 1);
    assert.equal(plan.carriedDebts[0].carriedCents, 15000);
    assert.throws(() => planPayoutBaselineAdoptions(source, stored(), { ...control, owner: 'D1' }), /Sheets ownership/);
    assert.throws(() => planPayoutBaselineAdoptions([{ ...source[0], body: { ...body, balance: '180' } }, source[1]], stored(), control), /differ|Invalid source entry/);
    assert.throws(() => planPayoutBaselineAdoptions([source[0], { ...source[1], body: { ...source[1].body, balance: '140' } }], stored(), control), /Carried debt/);
    assert.throws(() => planPayoutBaselineAdoptions(source, [], control), /roster/);
    await postPayoutTransaction(adapter, plan.commands[0], 'owner');
    assert.equal(planPayoutBaselineAdoptions(source, stored(), control).commands.length, 0);
    assert.equal(planPayoutBaselineAdoptions(source, stored(), control).accepted, 1);
    const journal = sqlite.prepare('SELECT * FROM payout_journal').get();
    assert.equal(journal.after_cents, 17000);
    assert.equal(journal.money_in_cents, 0);
    assert.equal(journal.money_out_cents, 0);
    assert.equal((await postPayoutTransaction(adapter, plan.commands[0], 'owner')).replayed, true);
    assert.throws(() => allocatePayoutPeriods({ periods, weeks: Array(19).fill(''), balanceCents: -500 }, ['1'], 1000), /Insufficient/);
    source[0].body = { ...body, balance: '180', weeks: ['10', '10', '10', ...Array(16).fill('')] };
    const feePlan = planPayoutBaselineAdoptions(source, stored(), control);
    assert.equal(feePlan.commands[0].type, 'SOURCE_ENTRY_FEES');
    await postPayoutTransaction(adapter, feePlan.commands[0], 'owner');
    assert.equal(planPayoutBaselineAdoptions(source, stored(), control).commands.length, 0);
    const fee = sqlite.prepare("SELECT * FROM payout_journal WHERE transaction_type='SOURCE_ENTRY_FEES'").get();
    assert.equal(fee.after_cents, 18000);
    assert.equal(fee.amount_cents, 1000);
    assert.equal(fee.money_in_cents + fee.money_out_cents, 0);
    assert.equal((await postPayoutTransaction(adapter, feePlan.commands[0], 'owner')).replayed, true);
  } finally { sqlite.close(); }
});

test('untouched stale imports adopt current source fees once in the opening balance', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
  try {
    const periods = [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'];
    const body = { name: 'Example', season: '2026', periods, weeks: ['10', '10', ...Array(17).fill('')], balance: '20', reconciliation: { status: 'match' } };
    await saveAdminRecord(adapter, { ...command(), kind: 'payout', expectedVersion: 0, operationId: 'import-stale-fee-balance', body }, 'source');
    const source = [{ kind: 'payout', recordId: 'payout:example', body: { ...body, weeks: ['10', '10', '10', ...Array(16).fill('')], balance: '30' } }];
    const plan = planPayoutBaselineAdoptions(source, sqlite.prepare('SELECT * FROM admin_records').all(), { owner: 'SHEETS', epoch: 1 });
    assert.deepEqual(plan.commands[0].sourceEntryPeriods, ['3']);
    await postPayoutTransaction(adapter, plan.commands[0], 'owner');
    assert.equal(JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body).balanceCents, 3000);
    const journal = sqlite.prepare('SELECT * FROM payout_journal').all();
    assert.equal(journal.length, 1);
    assert.equal(journal[0].after_cents, 3000);
    assert.equal(journal[0].money_in_cents + journal[0].money_out_cents, 0);
    assert.equal((await postPayoutTransaction(adapter, plan.commands[0], 'owner')).replayed, true);
  } finally { sqlite.close(); }
});

test('credits settle carried debt, partial entry debt and future fees in one replay-safe posting', async () => {
  const periods = [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'];
  const body = { name: 'Example', season: '2026', periods, weeks: ['10', '10', 'win', 'tie', ...Array(15).fill('')], balance: '170', balanceCents: 17000 };
  const partialCarry = settlePayoutCredit(body, 10000);
  assert.deepEqual(partialCarry.weeks, body.weeks);
  assert.equal(partialCarry.balanceCents, 7000);
  const partialEntry = settlePayoutCredit(body, 15500);
  assert.equal(partialEntry.weeks[0], '5');
  assert.equal(partialEntry.weeks[1], '10');
  assert.equal(partialEntry.balanceCents, 1500);
  const all = settlePayoutCredit(body, 35000);
  assert.equal(all.carriedDebtPaidCents, 15000);
  assert.equal(all.entryDebtPaidCents, 2000);
  assert.equal(all.prepaidCents, 16000);
  assert.equal(all.balanceCents, -2000);
  assert.deepEqual(all.weeks.slice(0, 4), ['paid', 'paid', 'win', 'tie']);
  assert.equal(all.weeks[18], 'paid');
  assert.throws(() => settlePayoutCredit({ ...body, balanceCents: 1000 }, 100), /exceeds/);
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
  try {
    const { balanceCents: acceptedCents, ...sourceBody } = body;
    await saveAdminRecord(adapter, { ...command(), kind: 'payout', expectedVersion: 0, operationId: 'import-credit-settlement', body: sourceBody }, 'source');
    await postPayoutTransaction(adapter, command(), 'owner');
    const payment = command({ type: 'PAYMENT_RECEIVED', amount: '350', expectedVersion: 2, operationId: 'settle-credit-payment' });
    sqlite.exec("CREATE TRIGGER fail_settlement BEFORE INSERT ON payout_journal WHEN NEW.transaction_type='PAYMENT_RECEIVED' BEGIN SELECT RAISE(ABORT,'forced settlement failure'); END");
    await assert.rejects(postPayoutTransaction(adapter, payment, 'owner'), /forced settlement/);
    assert.equal(JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body).balanceCents, 17000);
    sqlite.exec('DROP TRIGGER fail_settlement');
    await postPayoutTransaction(adapter, payment, 'owner');
    assert.equal((await postPayoutTransaction(adapter, payment, 'owner')).replayed, true);
    const saved = JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body);
    assert.deepEqual(saved.weeks, all.weeks);
    assert.equal(saved.balance, '+20');
    const journal = sqlite.prepare("SELECT * FROM payout_journal WHERE transaction_type='PAYMENT_RECEIVED'").all();
    assert.equal(journal.length, 1);
    assert.equal(journal[0].money_in_cents, 35000);
    assert.equal(journal[0].money_out_cents, 0);
    assert.equal(journal[0].after_cents, -2000);
    assert.equal(saved.posting.settlement.prepaidCents, 16000);
  } finally { sqlite.close(); }
});

test('weekly award reserves $20 and divides only the remaining pot deterministically', () => {
  assert.deepEqual(planWeeklyAward(31, ['Gary']), { grossCents: 31000, reserveCents: 2000, distributableCents: 29000,
    awards: [{ name: 'Gary', amountCents: 29000, periodStatus: 'win' }] });
  assert.deepEqual(planWeeklyAward(4, ['Zed', 'Amy', 'Bob']), { grossCents: 4000, reserveCents: 2000, distributableCents: 2000,
    awards: [{ name: 'Amy', amountCents: 667, periodStatus: 'tie' }, { name: 'Bob', amountCents: 667, periodStatus: 'tie' }, { name: 'Zed', amountCents: 666, periodStatus: 'tie' }] });
  assert.deepEqual(planWeeklyAward(1, ['Only']).awards, [{ name: 'Only', amountCents: 0, periodStatus: 'win' }]);
  assert.throws(() => planWeeklyAward(2, ['Same', 'same']), /unique/);
});

test('weekly awards post prize credit once and preserve the already-recorded entry fee', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
  try {
    const periods = [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'];
    await saveAdminRecord(adapter, { ...command(), kind: 'payout', expectedVersion: 0, operationId: 'import-award-account', body: { name: 'Winner', season: '2026', periods, weeks: ['10', ...Array(18).fill('')], balance: '10' } }, 'source');
    await postPayoutTransaction(adapter, command(), 'owner');
    const award = command({ recordId: 'payout:example', type: 'WEEKLY_AWARD', amount: '290', awardPeriod: '1', awardStatus: 'win', expectedVersion: 2, operationId: 'award-week-one-winner', reason: 'Week 1 winner: $310 pot less $20 season champion reserve' });
    await postPayoutTransaction(adapter, award, 'owner');
    assert.equal((await postPayoutTransaction(adapter, award, 'owner')).replayed, true);
    const saved = JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body);
    assert.equal(saved.weeks[0], 'win');
    assert.equal(saved.balanceCents, -28000);
    assert.equal(saved.balance, '+280');
    assert.equal(saved.posting.awardPeriod, '1');
    assert.equal(sqlite.prepare("SELECT count(*) AS total FROM payout_journal WHERE transaction_type='WEEKLY_AWARD'").get().total, 1);
    await assert.rejects(postPayoutTransaction(adapter, { ...award, operationId: 'award-week-one-again', expectedVersion: 3 }, 'owner'), /already recorded/);
  } finally { sqlite.close(); }
});