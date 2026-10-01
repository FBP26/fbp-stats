import { AdminConflict } from './admin-store.ts';
// The supervised CLI and the Worker use the same audited transaction primitive.
// @ts-ignore -- JavaScript module has no declaration file.
import { postPayoutTransaction } from '../scripts/payout-transactions.mjs';

type PrivateLedgerEnv = {
  DB: D1Database;
  CORS_ORIGIN: string;
  ADMIN_ACCESS_TOKEN?: string;
};

const privateJson = (body: Record<string, unknown>, status: number, origin: string) => Response.json(body, {
  status,
  headers: {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  },
});

const sameToken = (received: string, expected: string): boolean => {
  if (received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < received.length; index++) difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
};

export const privateLedgerAuthorized = (request: Request, env: PrivateLedgerEnv): boolean => {
  const token = env.ADMIN_ACCESS_TOKEN;
  const origin = request.headers.get('Origin');
  const authorization = request.headers.get('Authorization') || '';
  return Boolean(token && origin === env.CORS_ORIGIN && authorization.startsWith('Bearer ')
    && sameToken(authorization.slice('Bearer '.length), token));
};

const privateLedgerError = (request: Request, env: PrivateLedgerEnv): Response | null =>
  privateLedgerAuthorized(request, env) ? null : privateJson({ ok: false, error: 'Private admin authorization required.' }, 401, env.CORS_ORIGIN);

export async function privateLedgerRecords(request: Request, env: PrivateLedgerEnv): Promise<Response> {
  const denied = privateLedgerError(request, env);
  if (denied) return denied;
  const control = await env.DB.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first();
  const rows = await env.DB.prepare("SELECT record_id,version,body FROM admin_records WHERE kind='payout' ORDER BY CAST(json_extract(body, '$.season') AS INTEGER) DESC, json_extract(body, '$.name') COLLATE NOCASE").all();
  return privateJson({ ok: true, control, records: rows.results.map(row => ({ ...row, body: JSON.parse(String(row.body)) })) }, 200, env.CORS_ORIGIN);
}

export async function privateLedgerHistory(request: Request, env: PrivateLedgerEnv, recordId: string): Promise<Response> {
  const denied = privateLedgerError(request, env);
  if (denied) return denied;
  if (!/^payout:[A-Za-z0-9:_-]{1,150}$/.test(recordId)) return privateJson({ ok: false, error: 'Invalid payout record.' }, 400, env.CORS_ORIGIN);
  const rows = await env.DB.prepare("SELECT version,actor,reason,recorded_at,body FROM admin_events WHERE kind='payout' AND record_id=? ORDER BY version DESC").bind(recordId).all();
  return privateJson({ ok: true, history: rows.results.map(row => ({ ...row, body: JSON.parse(String(row.body)) })) }, 200, env.CORS_ORIGIN);
}

export async function privateLedgerTransaction(request: Request, env: PrivateLedgerEnv, payload: Record<string, unknown>): Promise<Response> {
  const denied = privateLedgerError(request, env);
  if (denied) return denied;
  if (!['PAYMENT_RECEIVED', 'CASH_PAID_OUT'].includes(String(payload.type))) {
    return privateJson({ ok: false, error: 'Select money received from or paid out to the player.' }, 400, env.CORS_ORIGIN);
  }
  try {
    const receipt = await postPayoutTransaction(env.DB, payload, 'mobile-admin');
    return privateJson({ ok: true, ...receipt }, 200, env.CORS_ORIGIN);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Payout transaction failed.';
    return privateJson({ ok: false, error: message }, error instanceof AdminConflict ? 409 : 400, env.CORS_ORIGIN);
  }
}