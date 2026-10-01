import test from 'node:test';
import assert from 'node:assert/strict';
import { privateLedgerAuthorized } from '../src/private-ledger.ts';

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