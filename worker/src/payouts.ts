import { SubmissionError } from './operational-submissions.ts';

export async function readOperationalPayouts(db: D1Database) {
  const control = await db.prepare('SELECT owner, epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
  if (control?.owner !== 'D1') throw new SubmissionError('Sheets currently owns payouts.');
  const records = (await db.prepare("SELECT body FROM admin_records WHERE kind='payout' ORDER BY record_id").all<{ body: string }>()).results.map(row => JSON.parse(row.body));
  if (!records.length) throw new SubmissionError('No approved payout records are available.');
  const currentYear = Math.max(...records.map(record => Number(record.season)));
  const seasons = new Map<number, { season: string; year: number; periods: string[]; playoffEntry: string; players: { name: string; weeks: string[]; balance: string }[] }>();
  for (const record of records) {
    const year = Number(record.season);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || typeof record.name !== 'string' || !record.name.trim()
      || !Array.isArray(record.periods) || record.periods.length !== 19 || !record.periods.every((value: unknown) => typeof value === 'string')
      || !Array.isArray(record.weeks) || record.weeks.length !== 19 || !record.weeks.every((value: unknown) => typeof value === 'string')
      || typeof record.balance !== 'string') throw new SubmissionError('Payout records are incomplete; reconcile before publication.');
    let balance = record.balance;
    if (year === currentYear) {
      if (!Number.isSafeInteger(record.balanceCents) || record.reconciliation?.status !== 'accepted-payout-baseline') throw new SubmissionError('The current payout baseline has not been accepted.');
      const cents = record.balanceCents;
      balance = cents === 0 ? 'even' : `${cents < 0 ? '+' : ''}${(Math.abs(cents) / 100).toFixed(2).replace(/\.00$/, '')}`;
      if (balance !== record.balance) throw new SubmissionError('Payout balance and audited cents disagree.');
    }
    let season = seasons.get(year);
    if (!season) {
      season = { season: `${year}-${year + 1}`, year, periods: [...record.periods], playoffEntry: '$20', players: [] };
      seasons.set(year, season);
    }
    if (JSON.stringify(season.periods) !== JSON.stringify(record.periods) || season.players.some(player => player.name.toLowerCase() === record.name.trim().toLowerCase())) throw new SubmissionError('Payout periods or player identities disagree.');
    season.players.push({ name: record.name.trim(), weeks: [...record.weeks], balance });
  }
  for (const season of seasons.values()) season.players.sort((left, right) => left.name.localeCompare(right.name));
  return { ok: true, owner: 'D1', epoch: control.epoch, seasons: [...seasons.values()].sort((left, right) => right.year - left.year) };
}