import { adminDigest, canonicalAdminJson } from './admin-store.ts';

export class SubmissionError extends Error {
  status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

export async function submitOperationalCard(db: D1Database, payload: Record<string, unknown>, now = new Date().toISOString()) {
  const control = await db.prepare('SELECT owner, epoch FROM admin_control WHERE id = 1').first<{ owner: string; epoch: number }>();
  if (control?.owner !== 'D1') throw new SubmissionError('Sheets currently owns submissions. No replacement-backend write was made.');
  const operationId = String(payload.operationId || '');
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(operationId)) throw new SubmissionError('A stable submission operation ID is required.', 400);
  const requestHash = await adminDigest(canonicalAdminJson(payload));
  const existing = await db.prepare('SELECT request_hash, body FROM operational_receipts WHERE operation_id = ?').bind(operationId).first<{ request_hash: string; body: string }>();
  if (existing) {
    if (existing.request_hash !== requestHash) throw new SubmissionError('Submission operation ID was reused with changed content.');
    return { ...JSON.parse(existing.body), replayed: true };
  }
  const name = String(payload.name || '').trim().replace(/\s+/g, ' ');
  const weekName = String(payload.weekName || '').trim();
  const season = Number(payload.season), weekNumber = Number(payload.week);
  const phase = payload.mode === 'test' ? 'PRESEASON' : String(payload.phase || 'REGULAR_SEASON');
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
  const bestBetIndex = phase === 'PLAYOFFS' && weekNumber === 4 ? 0 : picks.indexOf(String(payload.bestBet || '').trim().toUpperCase());
  if (bestBetIndex < 0) throw new SubmissionError('Best Bet must be one of the selected picks.', 400);
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
    bestBet: picks[bestBetIndex], tiebreaker, submittedAt: now, provenance: { source: 'D1', operationId } });
  const guard = `INSERT INTO operational_receipts(operation_id, request_hash, epoch, kind, body, recorded_at)
    SELECT ?, ?, ?, 'submission', ?, ? WHERE EXISTS (SELECT 1 FROM weeks WHERE id = ? AND status IN ('open','live'))
    AND COALESCE((SELECT submissions.id FROM submissions JOIN players ON players.id = player_id WHERE week_id = ? AND canonical_name = ? COLLATE NOCASE AND superseded_at IS NULL),0) = ?
    AND (? = 0 OR julianday(?) < (SELECT min(julianday(kickoff_at)) FROM games WHERE week_id = ?))
    AND (SELECT json_group_array(json_array(id,game_index,favorite,underdog,kickoff_at)) FROM (SELECT * FROM games WHERE week_id = ? ORDER BY game_index)) = ?`;
  const statements = [
    db.prepare(guard).bind(operationId, requestHash, control.epoch, JSON.stringify(receipt), now, week.id, week.id, name, current?.id || 0, current?.id || 0, now, week.id, week.id, slate),
    db.prepare('INSERT INTO players(canonical_name) SELECT ? WHERE EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id = ?) ON CONFLICT DO NOTHING').bind(name, operationId),
    db.prepare('UPDATE submissions SET superseded_at = ? WHERE id = ? AND EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id = ?)').bind(now, current?.id || 0, operationId),
    db.prepare(`INSERT INTO submissions(week_id,player_id,submitted_name,week_name,best_bet_game_index,tiebreaker,source,submitted_at)
      SELECT ?, players.id, ?, ?, ?, ?, 'website', ? FROM players WHERE canonical_name = ? COLLATE NOCASE AND EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id = ?)`)
      .bind(week.id, name, weekName, bestBetIndex, tiebreaker, now, name, operationId),
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
  ];
  try { await db.batch(statements); }
  catch (error) {
    const concurrent = await db.prepare('SELECT request_hash, body FROM operational_receipts WHERE operation_id = ?').bind(operationId).first<{ request_hash: string; body: string }>();
    if (concurrent?.request_hash === requestHash) return { ...JSON.parse(concurrent.body), replayed: true };
    throw error;
  }
  const accepted = await db.prepare('SELECT operation_id FROM operational_receipts WHERE operation_id = ?').bind(operationId).first();
  if (!accepted) throw new SubmissionError('The week or current card changed during submission. Reload and retry.');
  return receipt;
}