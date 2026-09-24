import { adminDigest, canonicalAdminJson, saveAdminRecord, AdminConflict } from '../src/admin-store.ts';

export function moneyCents(value) {
  const match = String(value).trim().match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('Invalid amount: use dollars with at most two decimal places.');
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

export function payoutBalanceCents(value) {
  const text = String(value).trim();
  if (!text || /^even$/i.test(text)) return 0;
  return moneyCents(text.replace(/^[+-]/, '')) * (text.startsWith('+') ? -1 : 1);
}

export function payoutBalanceText(cents) {
  if (!cents) return 'even';
  return `${cents < 0 ? '+' : ''}${(Math.abs(cents) / 100).toFixed(2).replace(/\.00$/, '')}`;
}

const transactions = {
  PAYMENT_RECEIVED: { direction: -1, moneyIn: true },
  PRIZE_CREDIT: { direction: -1 },
  CASH_PAID_OUT: { direction: 1, moneyOut: true },
  PRIZE_PAID: { direction: 0, moneyOut: true },
  PLAYER_DEBT_ADJUSTMENT: { direction: 1 },
  PLAYER_CREDIT_ADJUSTMENT: { direction: -1 },
};

export async function postPayoutTransaction(db, command, actor) {
  const opening = command.type === 'ADOPT_PAYOUT_BASELINE';
  if (!opening && !transactions[command.type]) throw new Error('Invalid payout transaction type.');
  const requestHash = await adminDigest(canonicalAdminJson({ command, actor }));
  const prior = await db.prepare('SELECT version, body FROM admin_events WHERE operation_id = ?').bind(command.operationId).first();
  if (prior) {
    if (JSON.parse(prior.body).posting?.requestHash !== requestHash) throw new AdminConflict('Operation ID was already used for different content.');
    return { version: prior.version, replayed: true };
  }
  const record = await db.prepare("SELECT version, body FROM admin_records WHERE kind = 'payout' AND record_id = ?").bind(command.recordId).first();
  if (!record) throw new Error('Invalid payout record.');
  const body = JSON.parse(record.body);
  const season = await db.prepare("SELECT MAX(CAST(json_extract(body, '$.season') AS INTEGER)) AS season FROM admin_records WHERE kind = 'payout'").first();
  if (Number(body.season) !== season.season) throw new Error('Historical payout balances are not editable.');
  if (opening && body.balanceCents !== undefined) throw new AdminConflict('Payout baseline has already been accepted.');
  if (!opening && !Number.isSafeInteger(body.balanceCents)) throw new Error('Accept the Payout baseline before recording transactions.');
  const beforeCents = opening ? 0 : body.balanceCents;
  const amountCents = opening ? Math.abs(payoutBalanceCents(body.balance)) : moneyCents(command.amount);
  if (!opening && amountCents <= 0) throw new Error('Invalid transaction amount: enter a positive amount.');
  const balanceCents = opening ? payoutBalanceCents(body.balance) : beforeCents + transactions[command.type].direction * amountCents;
  if (!Number.isSafeInteger(balanceCents)) throw new Error('Invalid resulting balance.');
  const posting = { operationId: command.operationId, requestHash, type: command.type, amountCents, beforeCents,
    moneyInCents: transactions[command.type]?.moneyIn ? amountCents : 0,
    moneyOutCents: transactions[command.type]?.moneyOut ? amountCents : 0 };
  const next = { ...body, balanceCents, balance: payoutBalanceText(balanceCents), posting,
    reconciliation: opening ? { ...body.reconciliation, status: 'accepted-payout-baseline', sourceBalance: body.balance, acceptedBy: actor, reason: command.reason } : body.reconciliation };
  return saveAdminRecord(db, { kind: 'payout', recordId: command.recordId, operationId: command.operationId,
    expectedVersion: command.expectedVersion, expectedEpoch: command.expectedEpoch, reason: command.reason, body: next }, actor);
}