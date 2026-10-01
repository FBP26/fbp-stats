import { adminDigest, canonicalAdminJson } from './admin-store.ts';

export class SubmissionError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

async function receiptWithSubmissionId(db: D1Database, receipt: Record<string, unknown>) {
  const link = await db.prepare('SELECT submission_id FROM admin_submission_links WHERE record_id=?')
    .bind(`operational:${receipt.operationId}`).first<{ submission_id: number }>();
  if (!link) throw new SubmissionError('Accepted submission receipt is missing its card link. Contact the owner.', 503);
  return { ...receipt, submissionId: link.submission_id };
}

export async function existingOperationalCard(db: D1Database, payload: Record<string, unknown>, now = Date.now()) {
  const control = await db.prepare('SELECT owner, epoch FROM admin_control WHERE id = 1').first<{ owner: string; epoch: number }>();
  if (control?.owner !== 'D1') throw new SubmissionError('Sheets currently owns submissions.');
  const name = String(payload.name || '').trim().replace(/\s+/g, ' ');
  const season = Number(payload.season), week = Number(payload.week);
  const phase = String(payload.phase || 'REGULAR_SEASON');
  if (!name || name.length > 13 || !Number.isInteger(season) || !Number.isInteger(week) || !['REGULAR_SEASON', 'PRESEASON', 'PLAYOFFS'].includes(phase)) throw new SubmissionError('Invalid submission lookup.', 400);
  const target = await db.prepare('SELECT id, status FROM weeks WHERE season=? AND week=? AND phase=?').bind(season, week, phase).first<{ id: number; status: string }>();
  if (!target) throw new SubmissionError('This week is not staged.');
  const current = await db.prepare(`SELECT submissions.id, submitted_at, canonical_name FROM submissions
    JOIN players ON players.id=player_id WHERE week_id=? AND canonical_name=? COLLATE NOCASE AND superseded_at IS NULL`)
    .bind(target.id, name).first<{ id: number; submitted_at: string; canonical_name: string }>();
  const games = (await db.prepare('SELECT kickoff_at FROM games WHERE week_id=?').bind(target.id).all<{ kickoff_at: string }>()).results;
  const kickoff = Math.min(...games.map(game => Date.parse(game.kickoff_at)));
  const open = ['open', 'live'].includes(target.status) && games.length > 0 && Number.isFinite(kickoff);
  return { ok: true, season, week, phase, owner: 'D1', epoch: control.epoch,
    exists: Boolean(current), submissionId: current?.id ?? null, submittedAt: current?.submitted_at ?? null,
    name: current?.canonical_name ?? name, replacementLocked: Boolean(current) && (!open || now >= kickoff),
    canSubmit: open && (!current || now < kickoff) };
}

export async function submitOperationalCard(db: D1Database, payload: Record<string, unknown>, now = new Date().toISOString()) {
  const control = await db.prepare('SELECT owner, epoch FROM admin_control WHERE id = 1').first<{ owner: string; epoch: number }>();
  if (control?.owner !== 'D1') throw new SubmissionError('Sheets currently owns submissions. No replacement-backend write was made.');
  if (payload.expectedEpoch != null && payload.expectedEpoch !== control.epoch) throw new SubmissionError('Pool ownership changed. Reload before submitting.');
  const operationId = String(payload.operationId || '');
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(operationId)) throw new SubmissionError('A stable submission operation ID is required.', 400);
  const requestHash = await adminDigest(canonicalAdminJson(payload));
  const existing = await db.prepare('SELECT request_hash, body FROM operational_receipts WHERE operation_id = ?').bind(operationId).first<{ request_hash: string; body: string }>();
  if (existing) {
    if (existing.request_hash !== requestHash) throw new SubmissionError('Submission operation ID was reused with changed content.');
    return receiptWithSubmissionId(db, { ...JSON.parse(existing.body), replayed: true });
  }
  const name = String(payload.name || '').trim().replace(/\s+/g, ' ');
  const weekName = String(payload.weekName || '').trim();
  const season = Number(payload.season), weekNumber = Number(payload.week);
  const phase = payload.mode === 'test' ? 'PRESEASON' : String(payload.phase || 'REGULAR_SEASON');
  const confirmationRequested = payload.confirmationEmailConsent === true;
  const confirmationEmail = String(payload.confirmationEmail || '').trim().toLowerCase();
  if (confirmationRequested && (confirmationEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(confirmationEmail))) {
    throw new SubmissionError('A valid confirmation email is required when email confirmation is selected.', 400);
  }
  if (!confirmationRequested && confirmationEmail) throw new SubmissionError('Email confirmation requires explicit consent.', 400);
  if (!name || name.length > 13 || !weekName || weekName.length > 255 || !Number.isInteger(season) || !Number.isInteger(weekNumber)
    || !['PRESEASON', 'REGULAR_SEASON', 'PLAYOFFS'].includes(phase)) throw new SubmissionError('Invalid name, week or phase.', 400);
  const tiebreakValue = phase === 'PLAYOFFS' && weekNumber < 4 ? 0 : payload.tiebreaker;
  const tiebreaker = Number(tiebreakValue);
  if (tiebreakValue == null || !['string','number'].includes(typeof tiebreakValue) || !/^-?(?:\d+|\d*\.\d{1,3})$/.test(String(tiebreakValue).trim()) || !Number.isFinite(tiebreaker) || tiebreaker < -100 || tiebreaker > 1200)
    throw new SubmissionError('A numeric tiebreaker from -100 through 1200 with at most 3 decimal places is required.', 400);
  const week = await db.prepare('SELECT id, status FROM weeks WHERE season = ? AND week = ? AND phase = ?').bind(season, weekNumber, phase).first<{ id: number; status: string }>();
  if (!week || !['open', 'live'].includes(week.status)) throw new SubmissionError('This week is not open for submissions.');
  if (phase === 'PLAYOFFS' && !await db.prepare('SELECT player_name FROM playoff_eligibility WHERE season=? AND player_name=? COLLATE NOCASE').bind(season,name).first())
    throw new SubmissionError('The player is not on the owner-approved playoff roster.', 403);
  const games = (await db.prepare('SELECT id, game_index, favorite, underdog, kickoff_at FROM games WHERE week_id = ? ORDER BY game_index').bind(week.id).all<{ id: number; game_index: number; favorite: string; underdog: string; kickoff_at: string }>()).results;
  const picks = Array.isArray(payload.picks) ? payload.picks.map(value => String(value).trim().toUpperCase()) : [];
  if (!games.length || picks.length !== games.length || games.some((game, index) => game.game_index !== index || !Number.isFinite(Date.parse(game.kickoff_at))
    || ![game.favorite.toUpperCase(), game.underdog.toUpperCase()].includes(picks[index]))) throw new SubmissionError('Picks do not match the approved slate.', 400);
  const bestBetTeam = phase === 'PLAYOFFS' && weekNumber === 4 ? picks[0] : String(payload.bestBet || '').trim().toUpperCase();
  const bestBetIndex = games.findIndex(game => [game.favorite.toUpperCase(), game.underdog.toUpperCase()].includes(bestBetTeam));
  if (bestBetIndex < 0) throw new SubmissionError('Best Bet must be a team on the approved slate.', 400);
  if (!picks.includes(bestBetTeam)) throw new SubmissionError('Best Bet must be one of the selected picks.', 400);
  const bestBet = games[bestBetIndex].favorite.toUpperCase() === bestBetTeam ? games[bestBetIndex].favorite : games[bestBetIndex].underdog;
  const current = await db.prepare('SELECT submissions.id FROM submissions JOIN players ON players.id = player_id WHERE week_id = ? AND canonical_name = ? COLLATE NOCASE AND superseded_at IS NULL').bind(week.id, name).first<{ id: number }>();
  const kickoff = Math.min(...games.map(game => Date.parse(game.kickoff_at)));
  if (current && Date.parse(now) >= kickoff) throw new SubmissionError('An existing card cannot be replaced after the first kickoff.');
  const expectedId = payload.expectedSubmissionId == null ? null : Number(payload.expectedSubmissionId);
  if ((current?.id ?? null) !== expectedId) throw new SubmissionError('The current card changed. Reload before replacing it.');
  const canonical = await db.prepare('SELECT canonical_name FROM players WHERE canonical_name = ? COLLATE NOCASE').bind(name).first<{ canonical_name: string }>();
  const canonicalName = canonical?.canonical_name || name;
  const receipt = { ok: true, submittedAt: now, operationId, identity: { status: 'known', submittedName: canonicalName, suggestedName: '', reason: '', canonicalizedFrom: name === canonicalName ? '' : name } };
  const slate = JSON.stringify(games.map(game => [game.id, game.game_index, game.favorite, game.underdog, game.kickoff_at]));
  const recordId = `operational:${operationId}`;
  const cardBody = JSON.stringify({ name: canonicalName, weekName, season: `${season}-${season + 1}`, week: weekNumber, phase,
    picks: games.map((game, index) => picks[index] === game.favorite.toUpperCase() ? game.favorite : game.underdog),
    bestBet, tiebreaker, submittedAt: now, provenance: { source: 'D1', operationId } });
  const financialStatements: D1PreparedStatement[] = [];
  let financialGuard = '';
  const financialBindings: (string | number)[] = [];
  if (phase !== 'PRESEASON') {
    const matches = (await db.prepare("SELECT record_id,version,body FROM admin_records WHERE kind='payout' AND CAST(json_extract(body,'$.season') AS INTEGER)=? AND json_extract(body,'$.name')=? COLLATE NOCASE")
      .bind(season, canonicalName).all<{ record_id: string; version: number; body: string }>()).results;
    if (matches.length > 1) throw new SubmissionError('Player financial identity requires owner reconciliation.');
    const account = matches[0];
    const periods = [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'];
    const financialBody = account ? JSON.parse(account.body) : { name: canonicalName, season: String(season), periods, weeks: Array(19).fill(''), balanceCents: 0, balance: 'even', reconciliation: { status: 'accepted-payout-baseline', source: 'new-D1-account' } };
    if (!Number.isSafeInteger(financialBody.balanceCents) || financialBody.reconciliation?.status !== 'accepted-payout-baseline'
      || JSON.stringify(financialBody.periods) !== JSON.stringify(periods) || financialBody.weeks?.length !== 19) throw new SubmissionError('Player financial baseline requires owner reconciliation.');
    const periodIndex = phase === 'PLAYOFFS' ? 18 : weekNumber - 1;
    if (periodIndex < 0 || periodIndex > 18 || (phase === 'REGULAR_SEASON' && periodIndex === 18)) throw new SubmissionError('Invalid fee period.', 400);
    const payoutId = account?.record_id ?? `payout:${await adminDigest(`${season}:${canonicalName.toLowerCase()}`)}`;
    financialGuard = ` AND (SELECT count(*) FROM admin_records WHERE kind='payout' AND CAST(json_extract(body,'$.season') AS INTEGER)=? AND json_extract(body,'$.name')=? COLLATE NOCASE)=?
      AND COALESCE((SELECT version FROM admin_records WHERE kind='payout' AND record_id=?),0)=?`;
    financialBindings.push(season, canonicalName, matches.length, payoutId, account?.version ?? 0);
    if (!current && String(financialBody.weeks[periodIndex]).trim() === '') {
      const amountCents = phase === 'PLAYOFFS' ? 2000 : 1000;
      const beforeCents = financialBody.balanceCents;
      const balanceCents = beforeCents + amountCents;
      const unpaidCents = Math.min(amountCents, Math.max(0, balanceCents));
      const formatAmount = (cents: number) => (Math.abs(cents) / 100).toFixed(2).replace(/\.00$/, '');
      const weeks = [...financialBody.weeks];
      weeks[periodIndex] = unpaidCents ? formatAmount(unpaidCents) : 'paid';
      const postingId = `entry:${operationId}`;
      const next = { ...financialBody, weeks, balanceCents, balance: balanceCents ? `${balanceCents < 0 ? '+' : ''}${formatAmount(balanceCents)}` : 'even',
        posting: { operationId: postingId, requestHash, type: 'ENTRY_FEE', amountCents, beforeCents, period: periods[periodIndex], submissionOperationId: operationId, moneyInCents: 0, moneyOutCents: 0 } };
      financialStatements.push(
        db.prepare(`INSERT INTO admin_events(operation_id,request_hash,kind,record_id,version,epoch,actor,reason,recorded_at,body)
          SELECT ?,?,'payout',?,?,?,'website','Entry fee for accepted original card',?,? WHERE EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id=?)`)
          .bind(postingId, requestHash, payoutId, (account?.version ?? 0) + 1, control.epoch, now, canonicalAdminJson(next), operationId),
        db.prepare(`INSERT INTO admin_records(kind,record_id,version,operation_id,body) SELECT kind,record_id,version,operation_id,body FROM admin_events WHERE operation_id=?
          ON CONFLICT(kind,record_id) DO UPDATE SET version=excluded.version,operation_id=excluded.operation_id,body=excluded.body`)
          .bind(postingId),
      );
    }
  }
  const guard = `INSERT INTO operational_receipts(operation_id, request_hash, epoch, kind, body, recorded_at)
    SELECT ?, ?, ?, 'submission', ?, ? WHERE EXISTS (SELECT 1 FROM weeks WHERE id = ? AND status IN ('open','live'))
    AND COALESCE((SELECT submissions.id FROM submissions JOIN players ON players.id = player_id WHERE week_id = ? AND canonical_name = ? COLLATE NOCASE AND superseded_at IS NULL),0) = ?
    AND (? = 0 OR julianday(?) < (SELECT min(julianday(kickoff_at)) FROM games WHERE week_id = ?))
    AND (SELECT json_group_array(json_array(id,game_index,favorite,underdog,kickoff_at)) FROM (SELECT * FROM games WHERE week_id = ? ORDER BY game_index)) = ?${financialGuard}`;
  const statements = [
    db.prepare(guard).bind(operationId, requestHash, control.epoch, JSON.stringify(receipt), now, week.id, week.id, name, current?.id || 0, current?.id || 0, now, week.id, week.id, slate, ...financialBindings),
    db.prepare('INSERT INTO players(canonical_name) SELECT ? WHERE EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id = ?) ON CONFLICT DO NOTHING').bind(name, operationId),
    db.prepare('UPDATE submissions SET superseded_at = ? WHERE id = ? AND EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id = ?)').bind(now, current?.id || 0, operationId),
    db.prepare(`INSERT INTO submissions(week_id,player_id,submitted_name,week_name,best_bet_game_index,best_bet_team,tiebreaker,source,submitted_at)
      SELECT ?, players.id, ?, ?, ?, ?, ?, 'website', ? FROM players WHERE canonical_name = ? COLLATE NOCASE AND EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id = ?)`)
      .bind(week.id, name, weekName, bestBetIndex, bestBet, tiebreaker, now, name, operationId),
    ...games.map((game, index) => db.prepare(`INSERT INTO submission_picks(submission_id,game_id,picked_team)
      SELECT submissions.id, ?, ? FROM submissions JOIN players ON players.id = player_id WHERE week_id = ? AND canonical_name = ? COLLATE NOCASE AND submitted_at = ?
      AND superseded_at IS NULL AND EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id = ?)`)
      .bind(game.id, picks[index] === game.favorite.toUpperCase() ? game.favorite : game.underdog, week.id, name, now, operationId)),
    db.prepare(`INSERT INTO admin_events(operation_id,request_hash,kind,record_id,version,epoch,actor,reason,recorded_at,body)
      SELECT ?, ?, 'submission', ?, 1, ?, 'website', 'Accepted operational submission', ?, ? WHERE EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id = ?)`)
      .bind(`card:${operationId}`, requestHash, recordId, control.epoch, now, cardBody, operationId),
    db.prepare(`INSERT INTO admin_records(kind,record_id,version,body,operation_id)
      SELECT kind,record_id,version,body,operation_id FROM admin_events WHERE operation_id = ?`).bind(`card:${operationId}`),
    db.prepare(`INSERT INTO admin_submission_links(record_id,submission_id)
      SELECT ?, submissions.id FROM submissions JOIN players ON players.id = player_id WHERE week_id = ? AND canonical_name = ? COLLATE NOCASE AND submitted_at = ?
      AND superseded_at IS NULL AND EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id = ?)`).bind(recordId, week.id, name, now, operationId),
    ...(confirmationRequested ? [db.prepare(`INSERT INTO submission_confirmation_outbox(submission_id,operation_id,destination,payload_json)
      SELECT submissions.id,?,?,? FROM submissions JOIN players ON players.id=player_id
      WHERE week_id=? AND canonical_name=? COLLATE NOCASE AND submitted_at=? AND superseded_at IS NULL
      AND EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id=?)`)
      .bind(operationId, confirmationEmail, JSON.stringify({ name: canonicalName, season, week: weekNumber, phase, weekName, picks: JSON.parse(cardBody).picks, bestBet, tiebreaker, submittedAt: now }), week.id, name, now, operationId)] : []),
    ...financialStatements,
  ];
  try { await db.batch(statements); }
  catch (error) {
    const concurrent = await db.prepare('SELECT request_hash, body FROM operational_receipts WHERE operation_id = ?').bind(operationId).first<{ request_hash: string; body: string }>();
    if (concurrent?.request_hash === requestHash) return receiptWithSubmissionId(db, { ...JSON.parse(concurrent.body), replayed: true });
    throw error;
  }
  const accepted = await db.prepare('SELECT operation_id FROM operational_receipts WHERE operation_id = ?').bind(operationId).first();
  if (!accepted) throw new SubmissionError('The week or current card changed during submission. Reload and retry.');
  return receiptWithSubmissionId(db, receipt);
}