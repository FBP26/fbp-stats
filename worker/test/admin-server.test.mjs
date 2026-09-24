import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createAdminServer, validateAdminChanges } from '../scripts/admin-server.mjs';
import { memoryDatabase } from './helpers/d1.mjs';
import { saveAdminRecord } from '../src/admin-store.ts';

test('admin rejects cross-origin and forged-host access and records validated edits', async () => {
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
  const port = 18819;
  const body = { name: 'Example', season: '2026', weeks: Array(19).fill(''), balance: '20', notes: '', provenance: { original: true } };
  await saveAdminRecord(adapter, { kind: 'payout', recordId: 'payout:test', operationId: 'initial-admin-record', expectedVersion: 0, expectedEpoch: 1, reason: 'Import', body }, 'source');
  const server = createAdminServer(adapter, { port, actor: 'owner' });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${port}`;
  try {
    const forgedHostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/api/records`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(forgedHostStatus, 403);
    assert.equal((await fetch(`${origin}/api/records`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/records`, { method: 'POST' })).status, 403);
    const request = { kind: 'payout', recordId: 'payout:test', operationId: 'owner-admin-edit-01', expectedVersion: 1, expectedEpoch: 1, reason: 'Receipt note recorded', changes: { notes: 'Receipt retained' } };
    const options = { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(request) };
    assert.equal((await fetch(`${origin}/api/records`, options)).status, 200);
    assert.equal((await fetch(`${origin}/api/records`, options)).status, 200);
    options.body = JSON.stringify({ ...request, operationId: 'owner-stale-edit-02' });
    assert.equal((await fetch(`${origin}/api/records`, options)).status, 409);
    options.body = JSON.stringify({ ...request, changes: { provenance: {} } });
    assert.equal((await fetch(`${origin}/api/records`, options)).status, 400);
    options.body = JSON.stringify({ ...request, changes: { balance: 'even' } });
    assert.equal((await fetch(`${origin}/api/records`, options)).status, 400);
    assert.equal(JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body).provenance.original, true);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_events').get().total, 2);
    options.body = JSON.stringify({ recordId: 'payout:test', operationId: 'http-adopt-balance', expectedVersion: 2, expectedEpoch: 1, type: 'ADOPT_PAYOUT_BASELINE', reason: 'Owner accepted balance' });
    assert.equal((await fetch(`${origin}/api/payout-transactions`, options)).status, 200);
    options.body = JSON.stringify({ recordId: 'payout:test', operationId: 'http-payment-received', expectedVersion: 3, expectedEpoch: 1, type: 'PAYMENT_RECEIVED', amount: '7.25', reason: 'Payment receipt' });
    assert.equal((await fetch(`${origin}/api/payout-transactions`, options)).status, 200);
    assert.equal((await fetch(`${origin}/api/payout-transactions`, options)).status, 200);
    assert.equal(JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body).balanceCents, 1275);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM payout_journal').get().total, 2);
    assert.equal((await fetch(`${origin}/api/payout-transactions`, { ...options, headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); sqlite.close(); }
});

test('submission validation rejects missing picks and unmatched Best Bets', () => {
  const card = { name: 'Example', weekName: 'None', picks: ['BUF'], bestBet: 'BUF', tiebreaker: 400 };
  assert.throws(() => validateAdminChanges(card, { bestBet: 'MIA' }, 'submission'), /Invalid/);
  assert.throws(() => validateAdminChanges(card, { picks: [] }, 'submission'), /Invalid/);
  assert.equal(validateAdminChanges(card, { weekName: 'None' }, 'submission').weekName, 'None');
});