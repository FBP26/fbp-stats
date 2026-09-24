import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { prepareSourceRecords, importSourceRecords, reconcilePayoutRecords } from '../scripts/admin-import.mjs';
import { saveAdminRecord, canonicalAdminJson } from '../src/admin-store.ts';
import { memoryDatabase } from './helpers/d1.mjs';

function fixture() {
  const header = ['submittedAt', 'season', 'week', 'name', 'weekName', ...Array.from({ length: 16 }, (_, index) => `Game ${index + 1}`), 'Best Bet', 'Tiebreaker', 'source', 'browserId'];
  const row = [46289.5, '2026-2027', 3, 'Example', 'None', ...Array(16).fill('BUF'), 'BUF', 400, 'website', 'private-browser'];
  const payout = [['2026'], ['Week', ...Array.from({ length: 19 }, (_, index) => String(index + 1))], ['metadata'], ['Example', ...Array(19).fill(''), '+20'], ['Champion']];
  return { version: 1, workbookId: 'book', timeZone: 'America/New_York', documents: [
    { sheetId: 1, title: 'website submissions', values: [header, row], display: [header, ['9/24/2026 12:00:00', ...row.slice(1)]], formulas: [header, row] },
    { sheetId: 2, title: 'payout', values: payout, display: payout, formulas: payout },
  ] };
}

test('private import preserves timestamps, literal None, balances and full source documents', async () => {
  const source = fixture();
  const records = await prepareSourceRecords(source);
  const card = records.find(record => record.kind === 'submission');
  assert.equal(card.body.submittedAtRaw, 46289.5);
  assert.equal(card.body.weekName, 'None');
  assert.equal(records.find(record => record.kind === 'payout').body.balance, '+20');
  assert.equal('browserId' in card.body, false);
  const ledger = records.find(record => record.kind === 'source-ledger');
  assert.equal(gunzipSync(Buffer.from(ledger.body.data, 'base64')).toString(), canonicalAdminJson(source.documents[0]));
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql']);
  try {
    assert.deepEqual(await importSourceRecords(adapter, records), { total: 4, inserted: 4, verified: true });
    assert.deepEqual(await importSourceRecords(adapter, records), { total: 4, inserted: 0, verified: true });
    await saveAdminRecord(adapter, { ...card, body: { ...card.body, weekName: 'Edited' }, expectedVersion: 1, expectedEpoch: 1, operationId: 'owner-correction-0001', reason: 'Owner correction' }, 'owner');
    await assert.rejects(importSourceRecords(adapter, records), /overwrite refused/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_events').get().total, 5);
  } finally { sqlite.close(); }
});

test('ambiguous identities and post-cutover imports fail closed', async () => {
  const source = fixture();
  source.documents[0].values.push(source.documents[0].values[1]);
  source.documents[0].display.push(source.documents[0].display[1]);
  await assert.rejects(prepareSourceRecords(source), /duplicate/);
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql']);
  try {
    sqlite.exec("UPDATE admin_control SET owner = 'D1', epoch = 2");
    await assert.rejects(importSourceRecords(adapter, await prepareSourceRecords(fixture())), /fenced/);
  } finally { sqlite.close(); }
});

test('financial reconciliation preserves both sides and flags mismatches rather than choosing a balance', () => {
  const records = ['+20', '30', '40', 'even'].map((balance, index) => ({ kind: 'payout', body: { name: `Player ${index}`, season: '2026', balance } }));
  const source = { documents: [{ title: 'payout ledger', values: [[], ['', '', 'Player 0', '', '', '', '', '', '', '', '', -20], ['', '', 'Player 1', '', '', '', '', '', '', '', '', 10]] }] };
  reconcilePayoutRecords(records, source);
  assert.deepEqual(records.map(record => record.body.reconciliation.status), ['match', 'mismatch', 'missing-ledger', 'match']);
  assert.equal(records[1].body.balance, '30');
  assert.equal(records[1].body.reconciliation.ledgerBalance, 10);
});