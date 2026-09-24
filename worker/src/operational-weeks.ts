import { adminDigest, canonicalAdminJson } from './admin-store.ts';
import { SubmissionError } from './operational-submissions.ts';

export async function approveOperationalWeek(db: D1Database, command: Record<string, unknown>, actor: string, now = new Date().toISOString()) {
  const operationId = String(command.operationId || '');
  const reason = String(command.reason || '').trim();
  const phase = String(command.phase), season = Number(command.season), week = Number(command.week);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(operationId) || !reason || reason.length > 500 || !actor
    || !Number.isInteger(season) || !Number.isInteger(week) || week < 1 || !['REGULAR_SEASON','PLAYOFFS'].includes(phase)
    || week > (phase === 'PLAYOFFS' ? 4 : 18)) throw new SubmissionError('Invalid owner approval.', 400);
  const hash = await adminDigest(canonicalAdminJson({ command, actor }));
  const priorReceipt = await db.prepare('SELECT request_hash,body FROM operational_receipts WHERE operation_id=?').bind(operationId).first<{ request_hash: string; body: string }>();
  if (priorReceipt) {
    if (priorReceipt.request_hash !== hash) throw new SubmissionError('Approval operation ID was reused.');
    return { ...JSON.parse(priorReceipt.body), replayed: true };
  }
  const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
  if (control?.owner !== 'D1' || control.epoch !== command.expectedEpoch) throw new SubmissionError('Week approval requires the current D1 ownership epoch.');
  const games = Array.isArray(command.games) ? command.games as Record<string, unknown>[] : [];
  if (!games.length || games.length > 16 || (phase === 'PLAYOFFS' && games.length !== [6,4,2,1][week-1])) throw new SubmissionError('Wrong number of games for the approved round.', 400);
  const teams = new Set<string>(), ids = new Set<string>();
  const normalized = games.map(game => {
    const externalId = String(game.gameId || ''), kickoff = String(game.kickoff || '');
    const favorite = String(game.favorite || '').toUpperCase(), underdog = String(game.underdog || '').toLowerCase();
    const home = String(game.home || '').toUpperCase(), away = String(game.away || '').toUpperCase();
    if (!externalId || ids.has(externalId) || !Number.isFinite(Date.parse(kickoff)) || Date.parse(kickoff) <= Date.parse(now)
      || !/^[A-Z]{2,4}$/.test(favorite) || !/^[a-z]{2,4}$/.test(underdog) || favorite === underdog.toUpperCase()
      || teams.has(favorite) || teams.has(underdog.toUpperCase()) || home === away
      || ![favorite,underdog.toUpperCase()].includes(home) || ![favorite,underdog.toUpperCase()].includes(away)
      || game.spread == null || String(game.spread).trim() === '' || !Number.isFinite(Number(game.spread))) throw new SubmissionError('Invalid, repeated or already-started matchup.', 400);
    ids.add(externalId); teams.add(favorite); teams.add(underdog.toUpperCase());
    return { externalId, kickoff: new Date(kickoff).toISOString(), favorite, underdog, home, away, spread: Number(game.spread), metadata: JSON.stringify(game) };
  }).sort((left,right) => left.kickoff.localeCompare(right.kickoff) || left.externalId.localeCompare(right.externalId));
  const eligible = Array.isArray(command.eligiblePlayers) ? command.eligiblePlayers.map(value => String(value).trim().replace(/\s+/g,' ')) : [];
  if (phase === 'PLAYOFFS' && (!eligible.length || eligible.some(name => !name || name.length > 100) || new Set(eligible.map(name=>name.toLowerCase())).size !== eligible.length)) throw new SubmissionError('An explicit unique playoff roster is required.', 400);
  if (phase === 'PLAYOFFS' && week > 1) {
    const previous = await db.prepare("SELECT status FROM weeks WHERE season=? AND week=? AND phase='PLAYOFFS'").bind(season,week-1).first<{status:string}>();
    if (previous?.status !== 'finalized') throw new SubmissionError('The previous playoff round must be finalized.');
    const roster = (await db.prepare('SELECT player_name FROM playoff_eligibility WHERE season=?').bind(season).all<{player_name:string}>()).results.map(row=>row.player_name.toLowerCase()).sort();
    if (JSON.stringify(roster)!==JSON.stringify(eligible.map(name=>name.toLowerCase()).sort())) throw new SubmissionError('The playoff roster cannot change between rounds.');
  }
  const body = { ok: true, season, week, phase, actor, reason, approvedAt: now, gameCount: games.length };
  const receiptGuard = `INSERT INTO operational_receipts(operation_id,request_hash,epoch,kind,body,recorded_at)
    SELECT ?,?,?, 'week-approval',?,? WHERE NOT EXISTS(SELECT 1 FROM weeks WHERE season=? AND week=? AND phase=?)
    AND NOT EXISTS(SELECT 1 FROM weeks WHERE phase=? AND status != 'finalized')
    AND (? != 'PLAYOFFS' OR ? = 1 OR EXISTS(SELECT 1 FROM weeks WHERE season=? AND week=? AND phase='PLAYOFFS' AND status='finalized'))`;
  const statements = [
    db.prepare(receiptGuard).bind(operationId,hash,control.epoch,JSON.stringify(body),now,season,week,phase,phase,phase,week,season,week-1),
    db.prepare("INSERT INTO weeks(season,week,phase,status,tiebreak_game_id,staged_at) SELECT ?,?,?,'open',?,? WHERE EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id=?)")
      .bind(season,week,phase,normalized.at(-1)!.externalId,now,operationId),
    ...normalized.map((game,index)=>db.prepare(`INSERT INTO games(week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team,metadata_json)
      SELECT id,?,?,?,?,?,?,?,?,? FROM weeks WHERE season=? AND week=? AND phase=? AND EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id=?)`)
      .bind(index,game.externalId,game.kickoff,game.favorite,game.underdog,game.spread,game.home,game.away,game.metadata,season,week,phase,operationId)),
  ];
  if (phase==='PLAYOFFS' && week===1) for (const player of eligible) statements.push(db.prepare('INSERT INTO playoff_eligibility(season,player_name,approved_operation) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM operational_receipts WHERE operation_id=?)').bind(season,player,operationId,operationId));
  await db.batch(statements);
  if (!await db.prepare('SELECT operation_id FROM operational_receipts WHERE operation_id=?').bind(operationId).first()) throw new SubmissionError('An active or existing week prevents this approval; no week was replaced or finalized.');
  return body;
}

export async function operationalPicksVisible(db: D1Database, weekId: number, now = new Date().toISOString()) {
  const week = await db.prepare('SELECT season,phase FROM weeks WHERE id=?').bind(weekId).first<{season:number;phase:string}>();
  if (!week) return false;
  if (week.phase!=='PLAYOFFS') return true;
  const eligible = await db.prepare('SELECT count(*) AS total FROM playoff_eligibility WHERE season=?').bind(week.season).first<{total:number}>();
  if (!eligible?.total) return false;
  const missing = await db.prepare(`SELECT count(*) AS total FROM playoff_eligibility AS roster WHERE season=? AND NOT EXISTS(
    SELECT 1 FROM submissions JOIN players ON players.id=player_id WHERE week_id=? AND superseded_at IS NULL AND canonical_name=roster.player_name COLLATE NOCASE)`)
    .bind(week.season,weekId).first<{total:number}>();
  const first = await db.prepare('SELECT min(kickoff_at) AS kickoff FROM games WHERE week_id=?').bind(weekId).first<{kickoff:string}>();
  return missing?.total===0 || Boolean(first?.kickoff && Date.parse(now)>=Date.parse(first.kickoff));
}