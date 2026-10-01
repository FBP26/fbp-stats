import { adminDigest, canonicalAdminJson, AdminConflict } from './admin-store.ts';
// The supervised CLI and the Worker use the same audited transaction primitive.
// @ts-ignore -- JavaScript module has no declaration file.
import { moneyCents, payoutBalanceText, postPayoutTransaction } from '../scripts/payout-transactions.mjs';

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

const postMobileCashPaidOut = async (db: D1Database, payload: Record<string, unknown>, actor: string): Promise<{ version: number; replayed: boolean }> => {
  const recordId = String(payload.recordId || '');
  const operationId = String(payload.operationId || '');
  const reason = String(payload.reason || '').trim();
  if (!/^payout:[A-Za-z0-9:_-]{1,150}$/.test(recordId) || !/^[A-Za-z0-9:_-]{16,160}$/.test(operationId) || !reason || reason.length > 500) {
    throw new Error('Invalid payout transaction.');
  }
  const amountCents = moneyCents(String(payload.amount || ''));
  if (amountCents <= 0) throw new Error('Enter a positive cash payout amount.');
  const [record, control] = await Promise.all([
    db.prepare("SELECT version,body FROM admin_records WHERE kind='payout' AND record_id=?").bind(recordId).first<{ version: number; body: string }>(),
    db.prepare('SELECT epoch FROM admin_control WHERE id=1').first<{ epoch: number }>(),
  ]);
  if (!record || !control) throw new Error('The payout ledger is unavailable. Try again shortly.');
  const command = { recordId, operationId, expectedVersion: Number(record.version), expectedEpoch: Number(control.epoch), type: 'CASH_PAID_OUT', amount: String(payload.amount), reason };
  const requestHash = await adminDigest(canonicalAdminJson({ command, actor }));
  const prior = await db.prepare('SELECT request_hash,version FROM admin_events WHERE operation_id=?').bind(operationId).first<{ request_hash: string; version: number }>();
  if (prior) {
    if (prior.request_hash !== requestHash) throw new AdminConflict('This transaction ID was already used for different details.');
    return { version: prior.version, replayed: true };
  }
  const body = JSON.parse(record.body) as Record<string, unknown>;
  const beforeCents = Number(body.balanceCents);
  if (!Number.isSafeInteger(beforeCents)) throw new Error('This payout balance needs reconciliation before cash can be recorded.');
  const balanceCents = beforeCents + amountCents;
  const next = {
    ...body,
    balanceCents,
    balance: payoutBalanceText(balanceCents),
    posting: { operationId, requestHash, type: 'CASH_PAID_OUT', amountCents, beforeCents, moneyInCents: 0, moneyOutCents: amountCents },
  };
  const eventBody = canonicalAdminJson(next);
  const recordedAt = new Date().toISOString();
  const results = await db.batch([
    db.prepare(`INSERT INTO admin_events (operation_id,request_hash,kind,record_id,version,epoch,actor,reason,recorded_at,body)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM admin_control WHERE id=1 AND epoch=?)
        AND EXISTS(SELECT 1 FROM admin_records WHERE kind='payout' AND record_id=? AND version=?)`)
      .bind(operationId, requestHash, 'payout', recordId, Number(record.version) + 1, Number(control.epoch), actor, reason, recordedAt, eventBody,
        Number(control.epoch), recordId, Number(record.version)),
    db.prepare(`UPDATE admin_records SET version=?,operation_id=?,body=? WHERE kind='payout' AND record_id=? AND version=?
      AND EXISTS(SELECT 1 FROM admin_events WHERE operation_id=? AND request_hash=?)`)
      .bind(Number(record.version) + 1, operationId, eventBody, recordId, Number(record.version), operationId, requestHash),
  ]);
  if (!results[0].meta.changes || !results[1].meta.changes) throw new AdminConflict('The ledger changed before this payout could be recorded.');
  return { version: Number(record.version) + 1, replayed: false };
};

export async function privateLedgerTransaction(request: Request, env: PrivateLedgerEnv, payload: Record<string, unknown>): Promise<Response> {
  const denied = privateLedgerError(request, env);
  if (denied) return denied;
  if (!['PAYMENT_RECEIVED', 'CASH_PAID_OUT'].includes(String(payload.type))) {
    return privateJson({ ok: false, error: 'Select money received from or paid out to the player.' }, 400, env.CORS_ORIGIN);
  }
  try {
    if (payload.type === 'CASH_PAID_OUT') {
      const receipt = await postMobileCashPaidOut(env.DB, payload, 'mobile-admin');
      return privateJson({ ok: true, ...receipt }, 200, env.CORS_ORIGIN);
    }
    const recordId = String(payload.recordId || '');
    const [record, control] = await Promise.all([
      env.DB.prepare("SELECT version FROM admin_records WHERE kind='payout' AND record_id=?").bind(recordId).first<{ version: number }>(),
      env.DB.prepare('SELECT epoch FROM admin_control WHERE id=1').first<{ epoch: number }>(),
    ]);
    if (!record || !control) return privateJson({ ok: false, error: 'The payout ledger is unavailable. Try again shortly.' }, 503, env.CORS_ORIGIN);
    const receipt = await postPayoutTransaction(env.DB, {
      ...payload,
      recordId,
      expectedVersion: Number(record.version),
      expectedEpoch: Number(control.epoch),
    }, 'mobile-admin');
    return privateJson({ ok: true, ...receipt }, 200, env.CORS_ORIGIN);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Payout transaction failed.';
    return privateJson({ ok: false, error: message }, error instanceof AdminConflict ? 409 : 400, env.CORS_ORIGIN);
  }
}