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

export function planWeeklyAward(participantCount, winnerNames) {
  if (!Number.isInteger(participantCount) || participantCount < 1 || !Array.isArray(winnerNames) || !winnerNames.length) throw new Error('Weekly award requires participant and winner counts.');
  const winners = winnerNames.map(name => String(name).trim().replace(/\s+/g, ' '));
  if (winners.some(name => !name) || new Set(winners.map(name => name.toLowerCase())).size !== winners.length) throw new Error('Weekly award winners must be unique.');
  const grossCents = participantCount * 1000;
  const reserveCents = Math.min(2000, grossCents);
  const distributableCents = grossCents - reserveCents;
  const ordered = [...winners].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'accent' }));
  const shareCents = Math.floor(distributableCents / ordered.length);
  const remainderCents = distributableCents % ordered.length;
  return { grossCents, reserveCents, distributableCents,
    awards: ordered.map((name, index) => ({ name, amountCents: shareCents + (index < remainderCents ? 1 : 0), periodStatus: ordered.length === 1 ? 'win' : 'tie' })) };
}

function sourceEntryFees(body, periods) {
  const expectedPeriods = [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'];
  if (JSON.stringify(body.periods) !== JSON.stringify(expectedPeriods) || body.weeks?.length !== 19
    || !Array.isArray(periods) || !periods.length || new Set(periods).size !== periods.length
    || periods.some(period => !expectedPeriods.includes(period))) throw new Error('Invalid source entry periods.');
  const weeks = [...body.weeks];
  let cents = 0;
  for (const period of periods) {
    const index = expectedPeriods.indexOf(period);
    if (weeks[index] !== '') throw new Error('Source entry fee would replace an existing period.');
    const fee = period === 'Playoffs' ? 20 : 10;
    weeks[index] = String(fee);
    cents += fee * 100;
  }
  return { weeks, cents, balance: payoutBalanceText(payoutBalanceCents(body.balance) + cents) };
}

export function planPayoutBaselineAdoptions(sourceRecords, storedRecords, control) {
  if (control?.owner !== 'SHEETS') throw new Error('Source baseline reconciliation requires Sheets ownership.');
  const source = sourceRecords.filter(record => record.kind === 'payout');
  const season = Math.max(...source.map(record => Number(record.body.season)));
  if (!Number.isInteger(season) || season < 2000) throw new Error('Invalid payout season.');
  const current = source.filter(record => Number(record.body.season) === season);
  const stored = storedRecords.filter(record => record.kind === 'payout').map(record => ({ ...record, body: typeof record.body === 'string' ? JSON.parse(record.body) : record.body }));
  const existing = new Map(stored.filter(record => Number(record.body.season) === season).map(record => [record.record_id, record]));
  if (existing.size !== current.length || new Set(current.map(record => record.recordId)).size !== current.length) throw new Error('Payout roster changed; baseline reconciliation stopped.');
  const commands = [];
  let accepted = 0;
  const carriedDebts = [];
  for (const record of current) {
    const previous = existing.get(record.recordId);
    if (!previous) throw new Error('Payout roster changed; baseline reconciliation stopped.');
    const changed = ['name', 'season', 'periods', 'weeks', 'balance'].filter(field => canonicalAdminJson(previous.body[field]) !== canonicalAdminJson(record.body[field]));
    let sourcePeriods;
    if (changed.length) {
      if (changed.some(field => !['weeks', 'balance'].includes(field)) || (previous.version !== 1 && previous.body.balanceCents === undefined)) throw new Error(`Payout source and stored values differ for ${record.body.name}; reconciliation stopped.`);
      sourcePeriods = record.body.periods.filter((period, index) => previous.body.weeks[index] !== record.body.weeks[index]);
      const update = sourceEntryFees(previous.body, sourcePeriods);
      if (canonicalAdminJson(update.weeks) !== canonicalAdminJson(record.body.weeks) || payoutBalanceCents(update.balance) !== payoutBalanceCents(record.body.balance)) throw new Error(`Payout source and stored values differ for ${record.body.name}; reconciliation stopped.`);
    }
    if (record.body.reconciliation?.status !== 'match') throw new Error('Payout ledger reconciliation is unresolved.');
    const balanceCents = payoutBalanceCents(record.body.balance);
    if (previous.body.balanceCents !== undefined) {
      if (previous.body.balanceCents !== payoutBalanceCents(previous.body.balance) || previous.body.reconciliation?.status !== 'accepted-payout-baseline') throw new Error('Accepted payout baseline differs from the source.');
      if (sourcePeriods) commands.push({ recordId: record.recordId, operationId: `sourcefees:${record.recordId}:${sourcePeriods.join('-')}`,
        expectedVersion: previous.version, expectedEpoch: control.epoch, type: 'SOURCE_ENTRY_FEES', amount: ((balanceCents - previous.body.balanceCents) / 100).toFixed(2),
        sourceEntryPeriods: sourcePeriods, reason: 'Mirror entry fees already recorded in the matched source ledger; no new source fee or cash movement.' });
      accepted++;
      continue;
    }
    const expectedPeriods = [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'];
    if (JSON.stringify(record.body.periods) !== JSON.stringify(expectedPeriods) || record.body.weeks.length !== 19) throw new Error('Invalid payout period layout.');
    const periodDebtCents = record.body.weeks.reduce((total, value, index) => {
      if (['', 'paid', 'win', 'tie'].includes(String(value).trim().toLowerCase())) return total;
      const cents = moneyCents(value);
      if (cents > (index === 18 ? 2000 : 1000)) throw new Error('Invalid period fee; reconciliation stopped.');
      return total + cents;
    }, 0);
    const carriedCents = Math.max(0, balanceCents) - periodDebtCents;
    if (carriedCents < 0) throw new Error('Entry debt exceeds the current balance; reconciliation stopped.');
    if (carriedCents) {
      const historical = source.filter(item => Number(item.body.season) === season - 1 && item.body.name.toLowerCase() === record.body.name.toLowerCase());
      if (historical.length !== 1 || payoutBalanceCents(historical[0].body.balance) !== carriedCents) throw new Error('Carried debt differs from the prior season; reconciliation stopped.');
      carriedDebts.push({ recordId: record.recordId, carriedCents });
    }
    commands.push({ recordId: record.recordId, operationId: `baseline:${record.recordId}`, expectedVersion: previous.version,
      ...(sourcePeriods ? { sourceEntryPeriods: sourcePeriods } : {}),
      expectedEpoch: control.epoch, type: 'ADOPT_PAYOUT_BASELINE', reason: `Migration: matched source periods and ledger; preserve ${carriedCents} cents prior-season debt and ${periodDebtCents} cents current entry debt. No cash received or paid.` });
  }
  return { season, total: current.length, accepted, commands, carriedDebts };
}

const transactions = {
  PAYMENT_RECEIVED: { direction: -1, moneyIn: true },
  PRIZE_CREDIT: { direction: -1 },
  CASH_PAID_OUT: { direction: 1, moneyOut: true },
  PRIZE_PAID: { direction: 0, moneyOut: true },
  PLAYER_DEBT_ADJUSTMENT: { direction: 1 },
  PLAYER_CREDIT_ADJUSTMENT: { direction: -1 },
  PREPAID_ALLOCATION: { direction: 1 },
  SOURCE_ENTRY_FEES: { direction: 1 },
  WEEKLY_AWARD: { direction: -1 },
};

export function allocatePayoutPeriods(body, periods, amountCents) {
  const expectedPeriods = [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'];
  if (!Array.isArray(body.periods) || JSON.stringify(body.periods) !== JSON.stringify(expectedPeriods)
    || !Array.isArray(body.weeks) || body.weeks.length !== 19) throw new Error('Invalid payout period layout.');
  if (!Array.isArray(periods) || !periods.length || new Set(periods).size !== periods.length
    || periods.some(period => !expectedPeriods.includes(period))) throw new Error('Select distinct valid payout periods.');
  const weeks = [...body.weeks];
  let allocationCents = 0;
  for (const period of periods) {
    const index = expectedPeriods.indexOf(period);
    if (String(weeks[index]).trim() !== '') throw new Error('Only blank, unallocated periods can be prepaid.');
    allocationCents += period === 'Playoffs' ? 2000 : 1000;
    weeks[index] = 'paid';
  }
  if (allocationCents !== amountCents) throw new Error('Allocation amount must match the selected period fees.');
  if (body.balanceCents > -allocationCents) throw new Error('Insufficient surplus for prepaid allocation.');
  return weeks;
}

export function settlePayoutCredit(body, amountCents) {
  const periods = [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'];
  if (JSON.stringify(body.periods) !== JSON.stringify(periods) || body.weeks?.length !== 19
    || !Number.isSafeInteger(body.balanceCents) || !Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Invalid payout settlement.');
  const debts = body.weeks.map((value, index) => {
    if (['', 'paid', 'win', 'tie'].includes(String(value).trim().toLowerCase())) return 0;
    const cents = moneyCents(value);
    if (cents > (index === 18 ? 2000 : 1000)) throw new Error('Invalid payout period debt.');
    return cents;
  });
  const entryDebt = debts.reduce((total, cents) => total + cents, 0);
  const carriedDebt = Math.max(0, body.balanceCents) - entryDebt;
  if (carriedDebt < 0) throw new Error('Entry debt exceeds the accepted balance.');
  const carriedDebtPaidCents = Math.min(amountCents, carriedDebt);
  let available = amountCents - carriedDebtPaidCents;
  let entryDebtPaidCents = 0;
  const weeks = body.weeks.map((value, index) => {
    if (!debts[index]) return value;
    const paid = Math.min(available, debts[index]);
    available -= paid;
    entryDebtPaidCents += paid;
    return paid === debts[index] ? 'paid' : payoutBalanceText(debts[index] - paid);
  });
  let balanceCents = body.balanceCents - amountCents;
  let prepaidCents = 0;
  const prepaidPeriods = [];
  for (let index = 0; index < weeks.length; index++) {
    if (String(weeks[index]).trim() !== '') continue;
    const fee = index === 18 ? 2000 : 1000;
    if (-balanceCents < fee) break;
    weeks[index] = 'paid';
    balanceCents += fee;
    prepaidCents += fee;
    prepaidPeriods.push(periods[index]);
  }
  return { weeks, balanceCents, carriedDebtPaidCents, entryDebtPaidCents, prepaidCents, prepaidPeriods };
}

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
  const sourceUpdate = command.sourceEntryPeriods === undefined ? null : sourceEntryFees(body, command.sourceEntryPeriods);
  if (sourceUpdate && !opening && command.type !== 'SOURCE_ENTRY_FEES') throw new Error('Invalid source entry transaction.');
  if (command.type === 'SOURCE_ENTRY_FEES' && (!sourceUpdate || sourceUpdate.cents !== moneyCents(command.amount))) throw new Error('Invalid source entry amount.');
  const openingBalance = sourceUpdate?.balance ?? body.balance;
  const amountCents = opening ? Math.abs(payoutBalanceCents(openingBalance)) : moneyCents(command.amount);
  if (!opening && amountCents <= 0) throw new Error('Invalid transaction amount: enter a positive amount.');
  const allocation = command.type === 'PREPAID_ALLOCATION';
  const award = command.type === 'WEEKLY_AWARD';
  if (!allocation && command.periods !== undefined) throw new Error('Periods require a prepaid allocation transaction.');
  if (award && (!['win', 'tie'].includes(command.awardStatus) || !Array.isArray(body.periods) || !Array.isArray(body.weeks)
    || body.periods.length !== 19 || body.weeks.length !== 19 || !body.periods.includes(command.awardPeriod))) throw new Error('Invalid weekly award period or result.');
  if (!award && (command.awardPeriod !== undefined || command.awardStatus !== undefined)) throw new Error('Award details require a weekly award transaction.');
  const awardWeeks = award ? (() => {
    const weeks = [...body.weeks];
    const index = body.periods.indexOf(command.awardPeriod);
    if (['win', 'tie'].includes(String(weeks[index]).trim().toLowerCase())) throw new Error('Weekly award was already recorded for this period.');
    weeks[index] = command.awardStatus;
    return weeks;
  })() : null;
  const settlement = ['PAYMENT_RECEIVED', 'PRIZE_CREDIT'].includes(command.type) ? settlePayoutCredit(body, amountCents) : null;
  const weeks = settlement?.weeks ?? awardWeeks ?? (allocation ? allocatePayoutPeriods(body, command.periods, amountCents) : sourceUpdate?.weeks ?? body.weeks);
  const balanceCents = settlement?.balanceCents ?? (opening ? payoutBalanceCents(openingBalance) : beforeCents + transactions[command.type].direction * amountCents);
  if (!Number.isSafeInteger(balanceCents)) throw new Error('Invalid resulting balance.');
  const posting = { operationId: command.operationId, requestHash, type: command.type, amountCents, beforeCents,
    ...(allocation ? { periods: [...command.periods] } : {}),
    ...(sourceUpdate ? { sourceEntryPeriods: [...command.sourceEntryPeriods] } : {}),
    ...(settlement ? { settlement: { carriedDebtPaidCents: settlement.carriedDebtPaidCents, entryDebtPaidCents: settlement.entryDebtPaidCents,
      prepaidCents: settlement.prepaidCents, prepaidPeriods: settlement.prepaidPeriods } } : {}),
    ...(award ? { awardPeriod: command.awardPeriod, awardStatus: command.awardStatus } : {}),
    moneyInCents: transactions[command.type]?.moneyIn ? amountCents : 0,
    moneyOutCents: transactions[command.type]?.moneyOut ? amountCents : 0 };
  const next = { ...body, ...(allocation || sourceUpdate || settlement || award ? { weeks } : {}), balanceCents, balance: payoutBalanceText(balanceCents), posting,
    reconciliation: opening ? { ...body.reconciliation, status: 'accepted-payout-baseline', sourceBalance: openingBalance, acceptedBy: actor, reason: command.reason } : body.reconciliation };
  return saveAdminRecord(db, { kind: 'payout', recordId: command.recordId, operationId: command.operationId,
    expectedVersion: command.expectedVersion, expectedEpoch: command.expectedEpoch, reason: command.reason, body: next }, actor);
}