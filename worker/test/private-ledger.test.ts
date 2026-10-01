import test from 'node:test';
import assert from 'node:assert/strict';
import { privateLedgerAuthorized, privateLedgerTransaction } from '../src/private-ledger.ts';
import { memoryDatabase } from './helpers/d1.mjs';
import { saveAdminRecord } from '../src/admin-store.ts';

const env = { DB: {} as D1Database, CORS_ORIGIN: 'https://fbp26.github.io', ADMIN_ACCESS_TOKEN: 'a-long-private-token' };

test('private mobile ledger requires the trusted site origin and exact bearer token', () => {
  const authorized = new Request('https://fbp-api.example/?action=private-ledger-records', {
    headers: { Origin: env.CORS_ORIGIN, Authorization: `Bearer ${env.ADMIN_ACCESS_TOKEN}` },
  });
  assert.equal(privateLedgerAuthorized(authorized, env), true);
  assert.equal(privateLedgerAuthorized(new Request('https://fbp-api.example/', { headers: { Origin: env.CORS_ORIGIN } }), env), false);
  assert.equal(privateLedgerAuthorized(new Request('https://fbp-api.example/', { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${env.ADMIN_ACCESS_TOKEN}` } }), env), false);
  assert.equal(privateLedgerAuthorized(new Request('https://fbp-api.example/', { headers: { Origin: env.CORS_ORIGIN, Authorization: 'Bearer wrong-token' } }), env), false);
});

test('private mobile ledger rejects transaction types outside owner cash directions', async () => {
  const request = new Request('https://fbp-api.example/', { headers: { Origin: env.CORS_ORIGIN, Authorization: `Bearer ${env.ADMIN_ACCESS_TOKEN}` } });
  const response = await privateLedgerTransaction(request, env, { type: 'PRIZE_CREDIT' });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /received from or paid out to/);
});

test('private mobile ledger posts against the latest server revision instead of a stale phone revision', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
  try {
    const body = { name: 'Example', season: '2026', periods: [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'], weeks: Array(19).fill(''), balance: '+190', balanceCents: -19000 };
    await saveAdminRecord(adapter, { kind: 'payout', recordId: 'payout:example', operationId: 'import-example-payout', expectedVersion: 0, expectedEpoch: 1, reason: 'Import', body }, 'source');
    const request = new Request('https://fbp-api.example/', { headers: { Origin: env.CORS_ORIGIN, Authorization: `Bearer ${env.ADMIN_ACCESS_TOKEN}` } });
    const response = await privateLedgerTransaction(request, { ...env, DB: adapter }, { recordId: 'payout:example', operationId: 'mobile-payout-example-01', expectedVersion: 0, expectedEpoch: 1, type: 'CASH_PAID_OUT', amount: '190', reason: 'Surplus paid' });
    assert.equal(response.status, 200, await response.text());
    assert.equal(JSON.parse(sqlite.prepare("SELECT body FROM admin_records WHERE record_id='payout:example'").get().body).balance, 'even');
  } finally { sqlite.close(); }
});