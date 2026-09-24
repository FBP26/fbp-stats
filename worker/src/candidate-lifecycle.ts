import { adminDigest, canonicalAdminJson } from './admin-store.ts';
import { calculatePaths, scoreWeekWithoutProbabilities, type PlayerCard } from './scoring.ts';
import { parseAlertFeed, type AlertFeed } from './alert-details.ts';

type Phase = 'REGULAR_SEASON' | 'PLAYOFFS';
interface CandidateObservation {
  season: number;
  week: number;
  phase: Phase;
  staged: boolean;
  feed: AlertFeed;
  actualTiebreaker: number | null;
  tiebreakFinal: boolean;
}

export function replacementSubmissionAllowed(existing: boolean, kickoff: number, now: number, status: string): boolean {
  return Number.isFinite(kickoff) && Number.isFinite(now) && ['open', 'live'].includes(status) && (!existing || now < kickoff);
}

export function playoffPicksVisible(cards: PlayerCard[], eligibleNames: string[], kickoff: number, now: number): boolean {
  if (!eligibleNames.length || !Number.isFinite(kickoff) || !Number.isFinite(now)) return false;
  const submitted = new Set(cards.map(card => card.name.trim().toLowerCase()));
  return now >= kickoff || eligibleNames.every(name => submitted.has(name.trim().toLowerCase()));
}

export async function recordCandidateObservation(db: D1Database, observation: CandidateObservation, observedAt: number): Promise<void> {
  const { season, week, phase, feed } = observation;
  const expectedGames = phase === 'PLAYOFFS' ? [6, 4, 2, 1][week - 1] : null;
  if (!observation.staged || !Number.isInteger(season) || season < 2000 || !Number.isInteger(week)
    || !['REGULAR_SEASON', 'PLAYOFFS'].includes(phase) || week < 1 || week > (phase === 'PLAYOFFS' ? 4 : 18)
    || !Number.isSafeInteger(observedAt) || observedAt <= 0 || !feed.games.length || feed.games.length > 16
    || (expectedGames != null && feed.games.length !== expectedGames)) throw new Error('Invalid staged candidate slate.');
  const games = feed.games;
  if (new Set(games.map(game => game.gameId)).size !== games.length || games.some(game => !game.gameId
    || !Number.isFinite(Date.parse(game.kickoff)) || !Number.isFinite(game.spread) || game.favorite === game.underdog
    || !['PREGAME', 'LIVE', 'FINAL'].includes(game.status)
    || (game.status !== 'PREGAME' && (game.favoriteScore === null || game.underdogScore === null
      || !Number.isInteger(game.favoriteScore) || !Number.isInteger(game.underdogScore) || game.favoriteScore < 0 || game.underdogScore < 0)))) throw new Error('Invalid candidate game state.');
  if (new Set(feed.cards.map(card => card.name.trim().toLowerCase())).size !== feed.cards.length
    || feed.cards.some(card => !card.name.trim() || card.picks.length !== games.length || !card.picks.includes(card.bestBet)
      || card.picks.some((pick, index) => ![games[index].favorite, games[index].underdog].includes(pick))
      || !Number.isFinite(card.tiebreaker) || card.tiebreaker < -100 || card.tiebreaker > 1200)) throw new Error('Invalid candidate card.');
  const firstKickoff = Math.min(...games.map(game => Date.parse(game.kickoff)));
  const allFinal = games.every(game => game.status === 'FINAL');
  const requiresTiebreak = phase === 'REGULAR_SEASON' || week === 4;
  const actual = requiresTiebreak ? observation.actualTiebreaker : null;
  const finalReady = allFinal && feed.cards.length > 0 && (!requiresTiebreak || (observation.tiebreakFinal && actual !== null && Number.isFinite(actual)));
  const status = finalReady ? 'finalized' : allFinal ? 'finalizing' : games.some(game => game.status !== 'PREGAME') ? 'live' : 'open';
  const slateHash = await adminDigest(canonicalAdminJson(games.map(game => [game.gameId, game.kickoff, game.favorite, game.underdog, game.spread])));
  const prior = await db.prepare('SELECT slate_hash, status, read_started_at FROM candidate_weeks WHERE season = ? AND week = ? AND phase = ?')
    .bind(season, week, phase).first<{ slate_hash: string; status: string; read_started_at: number }>();
  if (prior && prior.read_started_at >= observedAt) return;
  if (prior && prior.slate_hash !== slateHash) throw new Error('Candidate slate changed; explicit reconciliation required.');
  if (prior && ['live', 'finalizing', 'finalized'].includes(prior.status) && status === 'open') throw new Error('Candidate state cannot return to pregame.');
  if (phase === 'PLAYOFFS' && week > 1 && !prior) {
    const previous = await db.prepare("SELECT checksum FROM candidate_archives WHERE season = ? AND week = ? AND phase = 'PLAYOFFS'").bind(season, week - 1).first();
    if (!previous) throw new Error('The previous playoff round must be finalized first.');
  }
  const results = scoreWeekWithoutProbabilities(feed.cards, games, actual);
  const archivePayload = canonicalAdminJson({ season, week, phase, slateHash, games: games.map(({ clock, period, ...game }) => game), cards: feed.cards, results, actualTiebreaker: actual });
  const checksum = await adminDigest(archivePayload);
  const archive = await db.prepare('SELECT checksum FROM candidate_archives WHERE season = ? AND week = ? AND phase = ?').bind(season, week, phase).first<{ checksum: string }>();
  if (archive) {
    if (!finalReady || archive.checksum !== checksum) throw new Error('Finalized candidate result changed; archive remains immutable.');
    return;
  }
  const paths = calculatePaths(feed.cards, games);
  const frame = canonicalAdminJson({ observedAt, games, results: results.map((player, index) => ({ ...player, winProbability: paths.probabilities[index], pathsToVictory: paths.paths[index] })), outcomeCount: paths.outcomeCount, evaluatedCount: paths.evaluatedCount, sampled: paths.evaluatedCount < paths.outcomeCount });
  const sameObservation = 'EXISTS (SELECT 1 FROM candidate_weeks WHERE season = ? AND week = ? AND phase = ? AND read_started_at = ? AND slate_hash = ?)';
  await db.batch([
    db.prepare(`INSERT INTO candidate_weeks (season, week, phase, slate_hash, status, observed_open, observed_live, read_started_at, latest_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (season, week, phase) DO UPDATE SET
      status = excluded.status, observed_open = MAX(candidate_weeks.observed_open, excluded.observed_open),
      observed_live = MAX(candidate_weeks.observed_live, excluded.observed_live), read_started_at = excluded.read_started_at, latest_json = excluded.latest_json
      WHERE excluded.read_started_at > candidate_weeks.read_started_at AND excluded.slate_hash = candidate_weeks.slate_hash
      AND NOT EXISTS (SELECT 1 FROM candidate_archives WHERE season = ? AND week = ? AND phase = ?)`)
      .bind(season, week, phase, slateHash, status, status === 'open' && observedAt < firstKickoff ? 1 : 0, status === 'live' ? 1 : 0, observedAt, archivePayload, season, week, phase),
    db.prepare(`INSERT INTO candidate_race_frames (season, week, phase, interval_id, observed_at, payload_json)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${sameObservation} ON CONFLICT DO NOTHING`)
      .bind(season, week, phase, Math.floor(observedAt / 300000), observedAt, frame, season, week, phase, observedAt, slateHash),
    db.prepare(`INSERT INTO candidate_archives (season, week, phase, checksum, payload_json, finalized_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ? = 1 AND ${sameObservation} ON CONFLICT DO NOTHING`)
      .bind(season, week, phase, checksum, archivePayload, observedAt, finalReady ? 1 : 0, season, week, phase, observedAt, slateHash),
  ]);
}

export async function observeCandidatePublicWeek(db: D1Database, active: Record<string, unknown>, current: Record<string, unknown>, observedAt: number): Promise<void> {
  const season = Number(current.season), week = Number(current.week);
  const feed = parseAlertFeed(current, season, week);
  await recordCandidateObservation(db, { season, week, phase: 'REGULAR_SEASON', staged: active.staged === true, feed,
    actualTiebreaker: current.actualTiebreaker === '' || current.actualTiebreaker == null ? null : Number(current.actualTiebreaker),
    tiebreakFinal: current.tiebreakStatus === 'final' }, observedAt);
}