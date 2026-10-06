import { scoreWeek, scoreWeekWithoutProbabilities, type PlayerCard, type ScoringGame } from "./scoring.ts";
import { existingOperationalCard, submitOperationalCard, SubmissionError } from './operational-submissions.ts';
import { readOperationalPayouts } from './payouts.ts';
import { privateLedgerHistory, privateLedgerRecords, privateLedgerTransaction } from './private-ledger.ts';
// The private Ledger implementation is JavaScript because its supervised CLI shares these transactions.
// @ts-ignore -- typed at the Worker boundary below.
import { planWeeklyAward, postPayoutTransaction } from '../scripts/payout-transactions.mjs';
import { operationalPicksVisible, readOperationalSeasonStatus } from './operational-weeks.ts';
import { publicReadSnapshot, refreshPublicReadSnapshots } from "./read-snapshots.ts";
import { adaptCompletedArchive } from './completed-history-adapter.ts';
import { espnEventId, fetchEspnGame, isRefreshWindow, parseEspnGame, type StoredGame } from "./espn.ts";
import { validateRaceSnapshotPlayers } from "./race.ts";
import { alertEmailHtml, nightPaths, observeLeads, parseAlertFeed, type AlertFeed, type AlertObservation } from "./alert-details.ts";
import { maskNotificationDestination, normalizeNotificationDestination, notificationEvents, notificationPreferenceColumns, ordinalRank, parseNotificationPreferences, picksDueReminderIsEligible, scheduledNotificationEvents, seasonRankMovementSummary, weeklyRecapMessage, type NotificationChannel, type NotificationEvent, type SeasonStanding } from "./notifications.ts";
import { sendWebPush, type PushSubscriptionRecord } from "./web-push.ts";

interface Env {
  DB: D1Database;
  CORS_ORIGIN: string;
  EMAIL_RELAY_URL?: string;
  EMAIL_RELAY_SECRET?: string;
  ADMIN_SUBMISSION_EMAIL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  PUBLIC_API_URL?: string;
  PUBLIC_SITE_URL?: string;
  PICKS_SOURCE_URL?: string;
  CANDIDATE_LIFECYCLE_ENABLED?: string;
  OPERATIONAL_WRITES_ENABLED?: string;
  ADMIN_ACCESS_TOKEN?: string;
  ADMIN_PUSH_TEST_TOKEN?: string;
}

type JsonObject = Record<string, unknown>;
type WeeklyAwardPlan = { grossCents: number; reserveCents: number; awards: { name: string; amountCents: number; periodStatus: 'win' | 'tie' }[] };

const json = (body: JsonObject, status = 200, origin = "*"): Response =>
  Response.json(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Cache-Control": "no-store",
    },
  });

export const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
};

export const requestCorsOrigin = (request: Request, configuredOrigin: string): string => {
  const origin = request.headers.get("Origin") || "";
  return request.method === "GET" && isLoopbackOrigin(origin) ? origin : configuredOrigin;
};

const html = (body: string, status = 200): Response => new Response(body, {
  status,
  headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" },
});

const notificationPage = (title: string, body: string, status = 200): Response => html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#0d1117;color:#e8eef5;font:16px/1.55 Arial,sans-serif}main{width:min(560px,calc(100% - 32px));margin:48px auto;padding:28px;border:1px solid #2a3744;border-radius:6px;background:#151c24;box-sizing:border-box}h1{margin:0 0 10px;color:#ffcf40;font-size:26px;letter-spacing:0}p{margin:8px 0 18px}.alert-list{margin:10px 0 24px;padding-left:22px}.alert-list li{margin:5px 0}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.button{display:inline-block;padding:10px 16px;border:1px solid #ffcf40;border-radius:5px;background:#ffcf40;color:#111;text-decoration:none;font-weight:bold}.button.secondary{background:transparent;color:#e8eef5;border-color:#536273}@media(max-width:480px){main{margin:20px auto;padding:22px}.actions{display:grid}.button{text-align:center}}</style></head><body><main>${body}</main></body></html>`, status);

const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character] || character));

const requiredInteger = (value: string | null, fallback: number): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed)) throw new Error("Season and week must be integers.");
  return parsed;
};

const parsePayload = async (request: Request): Promise<JsonObject> => {
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A JSON object is required.");
  }
  return value as JsonObject;
};

const findWeek = async (
  db: D1Database,
  season: number,
  week: number,
  phase: string,
): Promise<Record<string, unknown> | null> =>
  db
    .prepare("SELECT * FROM weeks WHERE season = ? AND week = ? AND phase = ?")
    .bind(season, week, phase)
    .first();

const activeWeek = async (db: D1Database): Promise<Record<string, unknown> | null> =>
  db
    .prepare(
      `SELECT weeks.* FROM weeks JOIN admin_control ON admin_control.id=1
       WHERE status != 'finalized' AND (phase='REGULAR_SEASON' OR (phase='PLAYOFFS' AND owner='D1'))
       ORDER BY season DESC, CASE phase WHEN 'PLAYOFFS' THEN 1 ELSE 0 END DESC, week DESC LIMIT 1`,
    )
    .first();

const latestFinalizedRegularWeek = async (db: D1Database): Promise<Record<string, unknown> | null> =>
  db
    .prepare(
      `SELECT * FROM weeks
       WHERE phase = 'REGULAR_SEASON' AND status = 'finalized'
       ORDER BY season DESC, week DESC LIMIT 1`,
    )
    .first();

export const refreshActiveGameStates = async (db: D1Database, fetchGame = fetchEspnGame, now = new Date()): Promise<{ refreshed: number; skipped: string }> => {
  const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
  if (!control || !['SHEETS', 'D1'].includes(control.owner)) return { refreshed: 0, skipped: 'ownership-unavailable' };
  const week = await activeWeek(db);
  if (!week) return { refreshed: 0, skipped: "no-active-week" };
  const result = await db
    .prepare(
      `SELECT games.id, external_id, kickoff_at, favorite, underdog, home_team, away_team, metadata_json, game_states.state AS previous_state
       FROM games LEFT JOIN game_states ON game_states.game_id=games.id WHERE week_id = ? ORDER BY game_index`,
    )
    .bind(week.id)
    .all();
  const games: StoredGame[] = result.results.map((row) => ({
    id: Number(row.id),
    externalId: String(row.external_id),
    kickoffAt: String(row.kickoff_at),
    favorite: String(row.favorite),
    underdog: String(row.underdog),
    homeTeam: String(row.home_team),
    awayTeam: String(row.away_team),
    metadata: JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>,
  }));
  if (!games.length) return { refreshed: 0, skipped: "no-games" };
  if (!isRefreshWindow(games, now)) return { refreshed: 0, skipped: "outside-game-window" };
  const eventIds = games.map(espnEventId);
  if (eventIds.some((eventId) => !eventId)) return { refreshed: 0, skipped: "missing-espn-event-id" };
  const lastGameIndex = games.findIndex(game => game.externalId === week.tiebreak_game_id);
  if (lastGameIndex < 0) return { refreshed: 0, skipped: 'missing-approved-tiebreak-game' };
  const payloads = await Promise.all(eventIds.map(eventId => fetchGame(eventId)));
  const updatedAt = now.toISOString();
  const updates = games.map((game, index) => parseEspnGame(payloads[index], game));
  if (updates.some((update, index) => (result.results[index].previous_state === 'FINAL' && update.state !== 'FINAL')
    || (result.results[index].previous_state === 'LIVE' && update.state === 'PREGAME'))) return { refreshed: 0, skipped: 'regressive-game-state' };
  const guard = `EXISTS(SELECT 1 FROM admin_control WHERE id=1 AND owner=? AND epoch=?)
    AND EXISTS(SELECT 1 FROM weeks WHERE id=? AND status=? AND tiebreak_game_id IS ?)
    AND NOT EXISTS(SELECT 1 FROM game_states JOIN games ON games.id=game_id WHERE week_id=? AND julianday(game_states.updated_at)>julianday(?))`;
  const fenceValues = [control.owner, control.epoch, week.id, week.status, week.tiebreak_game_id, week.id, updatedAt];
  const statements: D1PreparedStatement[] = [];
  games.forEach((game, index) => {
    const update = updates[index];
    const metadata = {
      ...game.metadata,
      status: update.status,
      statusText: update.statusText,
      espnStatus: update.state === "LIVE" ? "in" : update.state === "FINAL" ? "post" : "pre",
      espnStatusText: update.statusText,
      espnHomeScore: update.homeScore ?? "",
      espnAwayScore: update.awayScore ?? "",
      homeScore: update.homeScore ?? "",
      awayScore: update.awayScore ?? "",
      period: update.period,
      clock: update.clock,
      possession: update.possession,
      ...(update.combinedNetPassingYards === null ? {} : { combinedNetPassingYards: update.combinedNetPassingYards }),
    };
    statements.push(
      db.prepare(
        `INSERT INTO game_states
         (game_id, state, favorite_score, underdog_score, period, clock, net_passing_yards, source_updated_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
         ON CONFLICT (game_id) DO UPDATE SET state = excluded.state,
           favorite_score = excluded.favorite_score, underdog_score = excluded.underdog_score,
           period = excluded.period, clock = excluded.clock,
           net_passing_yards = excluded.net_passing_yards,
           source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at`,
      ).bind(game.id, update.state, update.favoriteScore, update.underdogScore, update.period, update.clock,
        index === lastGameIndex ? update.combinedNetPassingYards : null, updatedAt, updatedAt, ...fenceValues),
      db.prepare(`UPDATE games SET metadata_json = ? WHERE id = ? AND ${guard}`).bind(JSON.stringify(metadata), game.id, ...fenceValues),
    );
  });
  const finalTiebreaker = updates[lastGameIndex].state === "FINAL" ? updates[lastGameIndex].combinedNetPassingYards : null;
  const weekStatus = updates.every((update) => update.state === "FINAL") ? "finalizing"
    : updates.some((update) => update.state === "LIVE" || update.state === "FINAL") ? "live" : String(week.status);
  statements.push(db.prepare(`UPDATE weeks SET status = ?, tiebreak_actual = ? WHERE id = ? AND ${guard}`)
    .bind(weekStatus, finalTiebreaker, week.id, ...fenceValues));
  const results = await db.batch(statements);
  if (!results.at(-1)?.meta.changes) return { refreshed: 0, skipped: 'ownership-or-week-changed' };
  return { refreshed: games.length, skipped: "" };
};

const getWeekConfig = async (db: D1Database, weekId: number): Promise<JsonObject[]> => {
  const result = await db
    .prepare(
      `SELECT g.game_index, g.external_id, g.kickoff_at, g.favorite, g.underdog,
              g.spread, g.home_team, g.away_team, g.metadata_json,
              s.state, s.favorite_score, s.underdog_score, s.period, s.clock,
              s.net_passing_yards, s.source_updated_at
       FROM games g
       LEFT JOIN game_states s ON s.game_id = g.id
       WHERE g.week_id = ? ORDER BY g.game_index`,
    )
    .bind(weekId)
    .all();

  return result.results.map((row) => ({
    gameIndex: row.game_index,
    gameId: row.external_id,
    kickoff: row.kickoff_at,
    favorite: row.favorite,
    underdog: row.underdog,
    spread: row.spread,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    ...(JSON.parse(String(row.metadata_json || "{}")) as JsonObject),
    state: row.state || "PREGAME",
    favoriteScore: row.favorite_score,
    underdogScore: row.underdog_score,
    period: row.period,
    clock: row.clock,
    netPassingYards: row.net_passing_yards,
    sourceUpdatedAt: row.source_updated_at,
  }));
};

const loadPlayerCards = async (db: D1Database, weekId: number): Promise<PlayerCard[]> => {
  const submissions = await db
    .prepare(
      `SELECT s.id, p.canonical_name, s.week_name, s.best_bet_game_index, s.best_bet_team,
              s.tiebreaker
       FROM submissions s
       JOIN players p ON p.id = s.player_id
       WHERE s.week_id = ? AND s.superseded_at IS NULL
       ORDER BY s.submitted_at`,
    )
    .bind(weekId)
    .all();
  if (!submissions.results.length) return [];
  const picks = await db
    .prepare(
      `SELECT sp.submission_id, g.game_index, sp.picked_team
       FROM submission_picks sp
       JOIN games g ON g.id = sp.game_id
       JOIN submissions s ON s.id = sp.submission_id
       WHERE s.week_id = ? AND s.superseded_at IS NULL
       ORDER BY sp.submission_id, g.game_index`,
    )
    .bind(weekId)
    .all();
  const picksBySubmission = new Map<number, string[]>();
  picks.results.forEach((row) => {
    const submissionId = Number(row.submission_id);
    const cardPicks = picksBySubmission.get(submissionId) || [];
    cardPicks[Number(row.game_index)] = String(row.picked_team);
    picksBySubmission.set(submissionId, cardPicks);
  });
  return submissions.results.map((row) => {
    const cardPicks = picksBySubmission.get(Number(row.id)) || [];
    return {
      name: String(row.canonical_name),
      weekName: String(row.week_name),
      picks: cardPicks,
      bestBet: String(row.best_bet_team || cardPicks[Number(row.best_bet_game_index)]),
      tiebreaker: Number(row.tiebreaker),
    };
  });
};

const loadArchiveSubmissions = async (db: D1Database, weekId: number, gameCount: number): Promise<JsonObject[]> => {
  const submissions = await db
    .prepare(
      `SELECT s.id, p.canonical_name, s.week_name, s.best_bet_game_index, s.best_bet_team,
              s.tiebreaker, s.source, s.submitted_at
       FROM submissions s
       JOIN players p ON p.id = s.player_id
       WHERE s.week_id = ? ORDER BY s.submitted_at, s.id`,
    )
    .bind(weekId)
    .all();
  const picks = await db
    .prepare(
      `SELECT sp.submission_id, g.game_index, sp.picked_team
       FROM submission_picks sp
       JOIN games g ON g.id = sp.game_id
       JOIN submissions s ON s.id = sp.submission_id
       WHERE s.week_id = ? ORDER BY sp.submission_id, g.game_index`,
    )
    .bind(weekId)
    .all();
  const picksBySubmission = new Map<number, string[]>();
  picks.results.forEach((row) => {
    const submissionId = Number(row.submission_id);
    const values = picksBySubmission.get(submissionId) || [];
    values[Number(row.game_index)] = String(row.picked_team);
    picksBySubmission.set(submissionId, values);
  });
  return submissions.results.map((row) => {
    const submissionPicks = picksBySubmission.get(Number(row.id)) || [];
    if (submissionPicks.length !== gameCount || submissionPicks.some((pick) => !pick)) {
      throw new Error(`${row.canonical_name} does not have one pick per staged game.`);
    }
    return {
      submittedAt: row.submitted_at,
      name: row.canonical_name,
      weekName: row.week_name,
      picks: submissionPicks,
      submittedGameCount: submissionPicks.length,
      bestBet: String(row.best_bet_team || submissionPicks[Number(row.best_bet_game_index)]),
      tiebreaker: Number(row.tiebreaker),
      source: row.source,
    };
  });
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const readCompletedHistory = async (db: D1Database): Promise<JsonObject> => {
  const control = await db.prepare('SELECT owner FROM admin_control WHERE id=1').first<{ owner: string }>();
  if (control?.owner !== 'D1') throw new Error('D1 completed history is not active.');
  const rows = (await db.prepare(`SELECT w.season,w.week,w.phase,w.finalized_at,a.payload_json,a.checksum
    FROM completed_week_archives a JOIN weeks w ON w.id=a.week_id
    WHERE w.status='finalized' ORDER BY w.season,w.phase,w.week`).all()).results;
  const weeks = await Promise.all(rows.map(async row => {
    const payload = String(row.payload_json);
    if (await sha256(payload) !== String(row.checksum)) throw new Error(`Archive digest mismatch for ${row.season} Week ${row.week}.`);
    const archive = JSON.parse(payload) as JsonObject;
    if (Number(archive.seasonStart) !== Number(row.season) || Number(archive.week) !== Number(row.week)
      || String(archive.phase) !== String(row.phase) || !Array.isArray(archive.games) || !Array.isArray(archive.submissions)) {
      throw new Error(`Archive contract mismatch for ${row.season} Week ${row.week}.`);
    }
    return { season: Number(row.season), week: Number(row.week), phase: String(row.phase), finalizedAt: String(row.finalized_at),
      archiveChecksum: String(row.checksum), sourceChecksum: String(archive.sourceChecksum || ''), actualTiebreaker: archive.actualTiebreaker,
      games: archive.games, submissions: archive.submissions };
  }));
  return { ok: true, version: 1, generatedFrom: 'D1 completed_week_archives', weeks };
};

export const readCompletedHistoryRecords = async (db: D1Database): Promise<JsonObject> => {
  const history = await readCompletedHistory(db) as unknown as { weeks: Array<Record<string, unknown>> };
  const records = history.weeks.map((week) => adaptCompletedArchive({
    season: `${Number(week.season)}-${Number(week.season) + 1}`,
    week: Number(week.week), phase: String(week.phase), actualTiebreaker: week.actualTiebreaker as number | null,
    games: week.games as never[], submissions: week.submissions as never[],
  }));
  return {
    ok: true, version: 1, generatedFrom: 'D1 completed_week_archives',
    archives: history.weeks.map((week) => ({ season: week.season, week: week.week, checksum: week.archiveChecksum })),
    games: records.flatMap((record) => record.games), picks: records.flatMap((record) => record.picks),
  };
};

export const finalizeWeek = async (db: D1Database, week: Record<string, unknown>): Promise<boolean> => {
  const tiebreakRequired = week.phase !== 'PLAYOFFS' || Number(week.week) === 4;
  if (String(week.status) !== 'finalizing' || (tiebreakRequired && (week.tiebreak_actual == null || !Number.isFinite(Number(week.tiebreak_actual))))) return false;
  const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
  if (!control || !['SHEETS', 'D1'].includes(control.owner)) return false;
  const weekId = Number(week.id);
  const signatures = [
    `SELECT json_group_array(json_array(id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team,metadata_json,state,favorite_score,underdog_score,period,clock,net_passing_yards,source_updated_at,updated_at)) FROM
      (SELECT games.*,game_states.state,game_states.favorite_score,game_states.underdog_score,game_states.period,game_states.clock,game_states.net_passing_yards,game_states.source_updated_at,game_states.updated_at
       FROM games LEFT JOIN game_states ON game_states.game_id=games.id WHERE week_id=? ORDER BY game_index)`,
    `SELECT json_group_array(json_array(id,player_id,canonical_name,submitted_name,week_name,best_bet_game_index,best_bet_team,tiebreaker,source,submitted_at,superseded_at)) FROM
      (SELECT submissions.*,players.canonical_name FROM submissions JOIN players ON players.id=player_id WHERE week_id=? ORDER BY submissions.id)`,
    `SELECT json_group_array(json_array(submission_id,game_id,picked_team)) FROM
      (SELECT submission_picks.* FROM submission_picks JOIN submissions ON submissions.id=submission_id WHERE week_id=? ORDER BY submission_id,game_id)`,
  ];
  const versions = await Promise.all(signatures.map(sql => db.prepare(`SELECT (${sql}) AS value`).bind(weekId).first<{ value: string }>()));
  const games = await getWeekConfig(db, weekId);
  if (!games.length || games.some((game) => game.state !== 'FINAL' || game.favoriteScore == null || game.underdogScore == null)) return false;
  if (await db.prepare('SELECT week_id FROM completed_week_archives WHERE week_id=?').bind(weekId).first()) return false;
  const submissions = await loadArchiveSubmissions(db, weekId, games.length);
  if (!submissions.length) throw new Error("A completed week must include at least one submission.");
  const season = Number(week.season);
  const weekNumber = Number(week.week);
  const finalizedAt = new Date().toISOString();
  const payload: JsonObject = {
    ok: true,
    archivedAt: finalizedAt,
    season: `${season}-${season + 1}`,
    seasonStart: season,
    week: weekNumber,
    phase: String(week.phase),
    actualTiebreaker: tiebreakRequired ? Number(week.tiebreak_actual) : null,
    games: games.map((game) => ({
      ...game,
      away: game.away || game.awayTeam,
      home: game.home || game.homeTeam,
      status: game.state,
    })),
    submissions: submissions.map((submission) => ({
      ...submission,
      season: `${season}-${season + 1}`,
      week: weekNumber,
      phase: String(week.phase),
      tiebreaker: tiebreakRequired ? submission.tiebreaker : null,
    })),
  };
  const payloadJson = JSON.stringify(payload);
  const checksum = await sha256(payloadJson);
  const guard = `EXISTS(SELECT 1 FROM admin_control WHERE id=1 AND owner=? AND epoch=?)
    AND EXISTS(SELECT 1 FROM weeks WHERE id=? AND status='finalizing' AND tiebreak_actual IS ?)
    AND ${signatures.map(sql => `(${sql})=?`).join(' AND ')}`;
  const fenceValues = [control.owner, control.epoch, weekId, week.tiebreak_actual,
    ...versions.flatMap(version => [weekId, version!.value])];
  const results = await db.batch([
    db.prepare(
      `INSERT INTO completed_week_archives (week_id, payload_json, checksum, finalized_at)
       SELECT ?, ?, ?, ? WHERE ${guard} ON CONFLICT (week_id) DO NOTHING`,
    ).bind(weekId, payloadJson, checksum, finalizedAt, ...fenceValues),
    db.prepare(`UPDATE weeks SET status = 'finalized', finalized_at = ? WHERE id = ? AND ${guard}
      AND EXISTS(SELECT 1 FROM completed_week_archives WHERE week_id=? AND checksum=?)`)
      .bind(finalizedAt, weekId, ...fenceValues, weekId, checksum),
  ]);
  return Boolean(results.at(-1)?.meta.changes);
};

export const awardFinalizedRegularWeek = async (db: D1Database, week: Record<string, unknown>, actor = 'system'): Promise<{ awarded: number; skipped: string }> => {
  if (week.phase !== 'REGULAR_SEASON' || week.status !== 'finalized' || !Number.isInteger(Number(week.season)) || !Number.isInteger(Number(week.week))) return { awarded: 0, skipped: 'not-finalized-regular-week' };
  const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
  if (control?.owner !== 'D1') return { awarded: 0, skipped: 'sheets-owner' };
  const games = await getWeekConfig(db, Number(week.id));
  const cards = await loadPlayerCards(db, Number(week.id));
  if (!cards.length || games.some(game => game.state !== 'FINAL')) throw new Error('Finalized weekly awards require complete final cards and games.');
  const scored = scoreWeekWithoutProbabilities(cards, games.map(game => ({ favorite: String(game.favorite), underdog: String(game.underdog), spread: Number(game.spread), status: String(game.state) as ScoringGame['status'], favoriteScore: Number(game.favoriteScore), underdogScore: Number(game.underdogScore) })), Number(week.tiebreak_actual));
  const top = Math.max(...scored.map(card => card.total));
  const tied = scored.filter(card => card.total === top);
  const closest = Math.min(...tied.map(card => card.tiebreakDifference ?? Number.POSITIVE_INFINITY));
  const winners = tied.filter(card => card.tiebreakDifference === closest).map(card => card.name);
  const award = planWeeklyAward(cards.length, winners) as WeeklyAwardPlan;
  const payouts = (await db.prepare("SELECT record_id,version,body FROM admin_records WHERE kind='payout' AND CAST(json_extract(body,'$.season') AS INTEGER)=?").bind(Number(week.season)).all<{ record_id: string; version: number; body: string }>()).results;
  const byName = new Map(payouts.map(record => [String(JSON.parse(record.body).name).toLowerCase(), record]));
  if (byName.size !== payouts.length || award.awards.some(item => !byName.has(item.name.toLowerCase()))) throw new Error('Finalized weekly award payout records require reconciliation.');
  let awarded = 0;
  for (const item of award.awards) {
    const record = byName.get(item.name.toLowerCase())!;
    const operationId = `weekly-award:${week.season}:${week.week}:${item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (await db.prepare('SELECT operation_id FROM admin_events WHERE operation_id=?').bind(operationId).first()) continue;
    const result = await postPayoutTransaction(db, { recordId: record.record_id, expectedVersion: record.version, expectedEpoch: control.epoch, operationId,
      type: 'WEEKLY_AWARD', amount: (item.amountCents / 100).toFixed(2), awardPeriod: String(week.week), awardStatus: item.periodStatus,
      reason: `Automatic Week ${week.week} award: ${award.grossCents / 100} pot less ${award.reserveCents / 100} season champion reserve.` }, actor);
    if (!result.replayed) awarded++;
  }
  return { awarded, skipped: '' };
};

const buildCurrentWeek = async (
  db: D1Database,
  week: Record<string, unknown>,
): Promise<JsonObject> => {
  const games = await getWeekConfig(db, Number(week.id));
  const picksVisible = await operationalPicksVisible(db, Number(week.id));
  const cards = picksVisible ? await loadPlayerCards(db, Number(week.id)) : [];
  const scoringGames: ScoringGame[] = games.map((game) => ({
    favorite: String(game.favorite),
    underdog: String(game.underdog),
    spread: Number(game.spread),
    status: String(game.state || "PREGAME") as ScoringGame["status"],
    favoriteScore: game.favoriteScore === null ? null : Number(game.favoriteScore),
    underdogScore: game.underdogScore === null ? null : Number(game.underdogScore),
  }));
  const actualTiebreaker = week.tiebreak_actual === null ? null : Number(week.tiebreak_actual);
  const players = scoreWeekWithoutProbabilities(cards, scoringGames, actualTiebreaker);
  return {
    ok: true,
    picksVisible,
    season: Number(week.season),
    seasonLabel: `${week.season}-${Number(week.season) + 1}`,
    week: Number(week.week),
    phase: String(week.phase),
    updatedAt: new Date().toISOString(),
    favorites: games.map((game) => game.favorite),
    favoriteScores: games.map((game) => game.favoriteScore),
    spreads: games.map((game) => game.spread),
    underdogScores: games.map((game) => game.underdogScore),
    underdogs: games.map((game) => game.underdog),
    actualTiebreaker: actualTiebreaker ?? "",
    tiebreakStatus: actualTiebreaker === null ? "live" : "final",
    probabilitySource: "client",
    games,
    players,
    raceSnapshots: [],
  };
};

export const recordScheduledRaceSnapshot = async (
  db: D1Database,
  week: Record<string, unknown>,
): Promise<boolean> => {
  if (String(week.phase) !== "REGULAR_SEASON" || String(week.status) === "finalized") return false;
  const weekId = Number(week.id);
  const games = await getWeekConfig(db, weekId);
  const cards = await loadPlayerCards(db, weekId);
  if (!games.length || !cards.length) return false;
  const scoringGames: ScoringGame[] = games.map((game) => ({
    favorite: String(game.favorite),
    underdog: String(game.underdog),
    spread: Number(game.spread),
    status: String(game.state || "PREGAME") as ScoringGame["status"],
    favoriteScore: game.favoriteScore === null ? null : Number(game.favoriteScore),
    underdogScore: game.underdogScore === null ? null : Number(game.underdogScore),
  }));
  const players = scoreWeek(cards, scoringGames, week.tiebreak_actual === null ? null : Number(week.tiebreak_actual));
  const gameStateJson = JSON.stringify(games.map((game) => ({
    gameId: game.gameId,
    away: game.away || game.awayTeam,
    home: game.home || game.homeTeam,
    awayScore: game.awayScore ?? "",
    homeScore: game.homeScore ?? "",
    status: game.status || game.state,
    period: game.period || "",
    clock: game.clock || "",
    possession: game.possession || "",
  })));
  const latest = await db.prepare(
    `SELECT player_name, win_probability, paths, game_state_json
     FROM race_snapshots WHERE week_id = ? AND captured_at = (
       SELECT MAX(captured_at) FROM race_snapshots WHERE week_id = ?
     )`,
  ).bind(weekId, weekId).all();
  const latestByName = new Map(latest.results.map((row) => [String(row.player_name), row]));
  const unchanged = latest.results.length === players.length
    && latest.results.every((row) => String(row.game_state_json) === gameStateJson)
    && players.every((player) => {
      const prior = latestByName.get(player.name);
      return prior && Number(prior.win_probability) === player.winProbability && Number(prior.paths) === player.pathsToVictory;
    });
  if (unchanged) return false;
  const capturedAt = new Date().toISOString();
  await db.batch(players.map((player) => db.prepare(
    `INSERT INTO race_snapshots
     (week_id, captured_at, player_name, win_probability, paths, win_pct, game_state_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(weekId, capturedAt, player.name, player.winProbability, player.pathsToVictory, player.winPercent || 0, gameStateJson)));
  return true;
};

const handleGet = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "current-week";
  if (action === 'private-ledger-records') return privateLedgerRecords(request, env);
  if (action === 'private-ledger-history') return privateLedgerHistory(request, env, url.searchParams.get('id') || '');
  if (action === 'backend-status') {
    const control = await env.DB.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
    if (!control) return json({ ok: false, error: 'Pool ownership is unavailable.' }, 503, env.CORS_ORIGIN);
    return json({ ok: true, ...control, writesEnabled: control.owner === 'D1' && env.OPERATIONAL_WRITES_ENABLED === 'true' }, 200, env.CORS_ORIGIN);
  }
  if (action === "public-read") return publicReadSnapshot(request, env.DB, env.CORS_ORIGIN);
  if (action === 'existing-submission') return json(await existingOperationalCard(env.DB, Object.fromEntries(url.searchParams)), 200, env.CORS_ORIGIN);
  if (action === 'payouts') return json(await readOperationalPayouts(env.DB), 200, env.CORS_ORIGIN);
  if (action === 'season-status') return json(await readOperationalSeasonStatus(env.DB), 200, env.CORS_ORIGIN);
  if (action === "analytics-status") return json({ ok: true, analytics: true }, 200, env.CORS_ORIGIN);
  if (action === "analytics-context") {
    const context = request.cf;
    const approximateCoordinate = (value: unknown): number | "" => {
      const coordinate = Number(value);
      return Number.isFinite(coordinate) ? coordinate : "";
    };
    return json({
      ok: true,
      country: context?.country || "",
      region: context?.region || "",
      regionCode: context?.regionCode || "",
      city: context?.city || "",
      latitude: approximateCoordinate(context?.latitude),
      longitude: approximateCoordinate(context?.longitude),
      continent: context?.continent || "",
    }, 200, env.CORS_ORIGIN);
  }
  if (action === "notification-status") return json({
    ok: true,
    players: await notificationRoster(env),
    channels: { push: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT), email: false, sms: false },
    vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
    reminderMinutes: { min: 1, max: 240, default: 60 },
    checkIntervalMinutes: 1,
  }, 200, env.CORS_ORIGIN);

  if (action === "verify-notifications" || action === "unsubscribe-notifications") {
    const rawToken = url.searchParams.get("token") || "";
    if (!/^[a-f0-9]{64}$/.test(rawToken)) return html("<h1>Invalid notification link</h1><p>This link is incomplete or has expired.</p>", 400);
    const tokenHash = await sha256(rawToken);
    if (action === "verify-notifications") {
      const subscription = await env.DB.prepare(
        "SELECT * FROM notification_subscriptions WHERE verification_token_hash = ? AND status IN ('pending', 'active')",
      ).bind(tokenHash).first<Record<string, unknown>>();
      if (!subscription) return html("<h1>Verification link expired</h1><p>Return to FBP and request a new verification email.</p>", 404);
      if (subscription.status !== "active") await env.DB.prepare(
        "UPDATE notification_subscriptions SET status = 'active', verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).bind(subscription.id).run();
      const enabledAlerts = notificationEvents.filter((event) => Number(subscription[notificationPreferenceColumns[event]]));
      const confirmationLabels: Record<NotificationEvent, string> = { picksReady: "When picks are ready", picksDue: "Picks due reminder", firstPlace: "When you move into first place", topFive: "When you jump into the top 5", topTen: "When you jump into the top 10", leadChange: "When the pool lead changes", earlyWindow: "After the early games", lateWindow: "After the late games", beforeSnf: "Before Sunday Night Football", beforeMnf: "Before Monday Night Football", weeklyResult: "Weekly result" };
      const alertItems = enabledAlerts.map((event) => `<li>${escapeHtml(confirmationLabels[event])}${event === "picksDue" ? ` (${Number(subscription.picks_due_minutes) || 60} minutes before kickoff)` : ""}</li>`).join("");
      const siteUrl = (env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/").replace(/\/$/, "");
      const editUrl = `${siteUrl}/?alerts=${encodeURIComponent(String(subscription.manage_token || ""))}#enter-picks`;
      const stopUrl = `${new URL(request.url).origin}/?action=unsubscribe-notifications&token=${encodeURIComponent(String(subscription.manage_token || ""))}`;
      return notificationPage("FBP alerts are on", `<h1>Your alerts are activated</h1><p>${escapeHtml(maskNotificationDestination(String(subscription.channel) as NotificationChannel, String(subscription.destination)))} is verified.</p><p>You have signed up for:</p><ul class="alert-list">${alertItems}</ul><p>You can edit or stop these alerts at any time.</p><div class="actions"><a class="button" href="${escapeHtml(editUrl)}">Edit alerts</a><a class="button secondary" href="${escapeHtml(stopUrl)}">Stop alerts</a></div>`);
    }
    const result = await env.DB.prepare(
      "UPDATE notification_subscriptions SET status = 'unsubscribed', unsubscribed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE manage_token_hash = ?",
    ).bind(tokenHash).run();
    return result.meta.changes
      ? html("<h1>FBP alerts stopped</h1><p>You will not receive additional messages. You can subscribe again from the FBP website.</p>")
      : html("<h1>Unsubscribe link expired</h1><p>No active notification contact was found for this link.</p>", 404);
  }

  if (action === "notification-preferences") {
    const rawToken = url.searchParams.get("token") || "";
    if (!/^[a-f0-9]{64}$/.test(rawToken)) return json({ ok: false, error: "This alert-management link is invalid." }, 400, env.CORS_ORIGIN);
    const subscription = await env.DB.prepare(
      "SELECT player_name, destination, picks_ready, picks_due, picks_due_minutes, first_place, early_window, late_window, before_snf, before_mnf, weekly_result FROM notification_subscriptions WHERE manage_token_hash = ? AND status = 'active'",
    ).bind(await sha256(rawToken)).first<Record<string, unknown>>();
    if (!subscription) return json({ ok: false, error: "This alert-management link has expired." }, 404, env.CORS_ORIGIN);
    return json({ ok: true, playerName: subscription.player_name, destination: subscription.destination, picksDueMinutes: subscription.picks_due_minutes, preferences: Object.fromEntries(notificationEvents.map((event) => [event, Boolean(Number(subscription[notificationPreferenceColumns[event]]))])) }, 200, env.CORS_ORIGIN);
  }

  if (action === "active-week") {
    const week = await activeWeek(env.DB);
    if (!week) {
      return json({ ok: true, staged: false, season: 2026, week: 1, phase: "REGULAR_SEASON", games: [] }, 200, env.CORS_ORIGIN);
    }
    const games = await getWeekConfig(env.DB, Number(week.id));
    return json({
      ok: true,
      staged: true,
      season: Number(week.season),
      week: Number(week.week),
      phase: String(week.phase),
      games,
      enrichmentError: "",
    }, 200, env.CORS_ORIGIN);
  }

  if (action === "current-week" || action === "week-one") {
    const week = await activeWeek(env.DB) ?? await latestFinalizedRegularWeek(env.DB);
    if (!week) return json({ ok: false, error: "No regular-season week is staged." }, 404, env.CORS_ORIGIN);
    const body = await buildCurrentWeek(env.DB, week);
    return json(body, 200, env.CORS_ORIGIN);
  }

  if (action === 'completed-history') {
    try {
      return json(await readCompletedHistory(env.DB), 200, env.CORS_ORIGIN);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'D1 completed history is unavailable.';
      return json({ ok: false, error: message }, message === 'D1 completed history is not active.' ? 409 : 503, env.CORS_ORIGIN);
    }
  }

  if (action === 'completed-history-records') {
    try {
      return json(await readCompletedHistoryRecords(env.DB), 200, env.CORS_ORIGIN);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'D1 completed history is unavailable.';
      return json({ ok: false, error: message }, message === 'D1 completed history is not active.' ? 409 : 503, env.CORS_ORIGIN);
    }
  }

  const season = requiredInteger(url.searchParams.get("season"), 2026);
  const weekNumber = requiredInteger(url.searchParams.get("week"), 1);
  const phase = action === "preseason-test" ? "PRESEASON" : url.searchParams.get("phase") || "REGULAR_SEASON";
  const week = await findWeek(env.DB, season, weekNumber, phase);
  if (!week) return json({ ok: false, error: "Week not found." }, 404, env.CORS_ORIGIN);
  const weekId = Number(week.id);

  if (action === "week-config") {
    const games = await getWeekConfig(env.DB, weekId);
    return json({ ok: true, season, week: weekNumber, phase, games, enrichmentError: "" }, 200, env.CORS_ORIGIN);
  }

  if (phase === 'PLAYOFFS') {
    if (!await operationalPicksVisible(env.DB, weekId)) return json({ ok: true, season, week: weekNumber, phase, picksVisible: false, players: [], raceSnapshots: [] }, 200, env.CORS_ORIGIN);
    if (action === 'playoff-round') return json(await buildCurrentWeek(env.DB, week), 200, env.CORS_ORIGIN);
  }

  if (action === "race-archive") {
    const result = await env.DB
      .prepare(
        `SELECT captured_at AS timestamp, player_name AS name,
                win_probability AS win_prob, paths, win_pct,
                game_state_json AS game_state
         FROM race_snapshots WHERE week_id = ?
         ORDER BY captured_at, player_name`,
      )
      .bind(weekId)
      .all();
    const frames = new Map<string, { timestamp: string; gameState: unknown; players: JsonObject[] }>();
    result.results.forEach((row) => {
      const timestamp = String(row.timestamp);
      const frame: { timestamp: string; gameState: unknown; players: JsonObject[] } = frames.get(timestamp) || {
        timestamp,
        gameState: JSON.parse(String(row.game_state || "[]")),
        players: [],
      };
      frame.players.push({
        name: row.name,
        winProbability: Number(row.win_prob),
        pathsToVictory: Number(row.paths),
        winPercent: Number(row.win_pct || 0),
      });
      frames.set(timestamp, frame);
    });
    const raceSnapshots = [...frames.values()].map((frame) => ({
      ...frame,
      players: frame.players
        .sort((left, right) => Number(right.winProbability) - Number(left.winProbability)
          || Number(right.pathsToVictory) - Number(left.pathsToVictory)
          || String(left.name).localeCompare(String(right.name))),
    }));
    return json({ ok: true, season, week: weekNumber, raceSnapshots }, 200, env.CORS_ORIGIN);
  }

  if (action === "week-archive") {
    const archive = await env.DB
      .prepare("SELECT payload_json FROM completed_week_archives WHERE week_id = ?")
      .bind(weekId)
      .first<{ payload_json: string }>();
    if (!archive) return json({ ok: false, error: "Completed week archive not found." }, 404, env.CORS_ORIGIN);
    return json(JSON.parse(archive.payload_json) as JsonObject, 200, env.CORS_ORIGIN);
  }

  if (action === "preseason-test") {
    const snapshot = await env.DB
      .prepare("SELECT payload_json FROM live_snapshots WHERE week_id = ? ORDER BY captured_at DESC LIMIT 1")
      .bind(weekId)
      .first<{ payload_json: string }>();
    const body = snapshot ? JSON.parse(snapshot.payload_json) as JsonObject : await buildCurrentWeek(env.DB, week);
    return json(body, 200, env.CORS_ORIGIN);
  }

  return json({ ok: false, error: "Unknown action." }, 400, env.CORS_ORIGIN);
};

const cleanText = (value: unknown, maxLength: number): string =>
  String(value ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, maxLength);

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const notificationRoster = async (env: Env): Promise<string[]> => {
  const response = await fetch(`${env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/"}data/players.json`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Player list unavailable. Try again shortly.");
  const rows = await response.json() as { name: string }[];
  if (!Array.isArray(rows) || !rows.length || rows.some(row => typeof row.name !== "string")) throw new Error("Player list unavailable.");
  const current = await env.DB.prepare("SELECT DISTINCT p.canonical_name FROM players p JOIN submissions s ON s.player_id = p.id").all<{ canonical_name: string }>();
  const names = new Map(rows.map(row => [row.name.toLowerCase(), row.name]));
  current.results.forEach(row => { if (!names.has(row.canonical_name.toLowerCase())) names.set(row.canonical_name.toLowerCase(), row.canonical_name); });
  return [...names.values()].sort((left, right) => left.localeCompare(right));
};

const notificationPlayerName = async (value: unknown, env: Env): Promise<string> => {
  const input = cleanText(value, 100).replace(/\s+/g, " ").toLowerCase();
  const name = (await notificationRoster(env)).find(name => name.toLowerCase() === input);
  if (!name) throw new Error("Choose an existing player from the player-name list.");
  return name;
};

const reminderMinutes = (value: unknown): number => {
  const minutes = value == null ? 60 : Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error("Reminder must be a whole number from 1 through 240 minutes.");
  return minutes;
};

const pushSubscriptionFromPayload = (value: unknown): PushSubscriptionRecord => {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const keys = source.keys && typeof source.keys === "object" ? source.keys as Record<string, unknown> : {};
  const endpoint = cleanText(source.endpoint, 2000);
  const p256dh = cleanText(keys.p256dh, 200);
  const auth = cleanText(keys.auth, 100);
  if (!/^https:\/\//.test(endpoint) || !/^[A-Za-z0-9_-]{80,}$/.test(p256dh) || !/^[A-Za-z0-9_-]{20,}$/.test(auth)) {
    throw new Error("This browser did not provide a valid push subscription.");
  }
  return { endpoint, p256dh, auth };
};

const administratorPushUrl = (candidate: unknown, env: Env): string => {
  const fallback = `${env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/"}#live-analysis`;
  const url = String(candidate || "").trim();
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(env.PUBLIC_SITE_URL || fallback).origin || parsed.origin === "https://script.google.com"
      ? parsed.toString()
      : fallback;
  } catch { return fallback; }
};

const sendAdministratorPush = async (env: Env, title: string, body: string, url?: string): Promise<{ sent: number; failed: number }> => {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return { sent: 0, failed: 0 };
  const devices = await env.DB.prepare(
    `SELECT devices.id, devices.endpoint, devices.p256dh, devices.auth
     FROM push_admin_devices administrators
     JOIN push_devices devices ON devices.id = administrators.device_id
     WHERE devices.status = 'active'`,
  ).all<{ id: number; endpoint: string; p256dh: string; auth: string }>();
  let sent = 0, failed = 0;
  for (const device of devices.results) {
    const result = await sendWebPush(
      device,
      { title: cleanText(title, 80), body: cleanText(body, 240), url: administratorPushUrl(url, env), tag: `fbp-admin-${crypto.randomUUID()}` },
      { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT },
    );
    if (result.expired) await env.DB.prepare("UPDATE push_devices SET status='unsubscribed', unsubscribed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(device.id).run();
    if (result.ok) sent++;
    else failed++;
  }
  return { sent, failed };
};

const sendAdministratorPushOnce = async (env: Env, eventType: string, deduplicationKey: string, title: string, body: string, url?: string, weekId?: number): Promise<{ sent: number; failed: number }> => {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return { sent: 0, failed: 0 };
  const devices = await env.DB.prepare(
    `SELECT devices.id, devices.endpoint, devices.p256dh, devices.auth
     FROM push_admin_devices administrators
     JOIN push_devices devices ON devices.id = administrators.device_id
     WHERE devices.status = 'active'`,
  ).all<{ id: number; endpoint: string; p256dh: string; auth: string }>();
  let sent = 0, failed = 0;
  for (const device of devices.results) {
    const queued = await env.DB.prepare(
      "INSERT INTO push_deliveries(device_id, week_id, event_type, deduplication_key, status) VALUES (?, ?, ?, ?, 'queued') ON CONFLICT(device_id, deduplication_key) DO NOTHING",
    ).bind(device.id, weekId ?? null, eventType, deduplicationKey).run();
    if (!queued.meta.changes) continue;
    const result = await sendWebPush(
      device,
      { title: cleanText(title, 80), body: cleanText(body, 240), url: administratorPushUrl(url, env), tag: `fbp-admin-${deduplicationKey}` },
      { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT },
    );
    if (result.expired) await env.DB.prepare("UPDATE push_devices SET status='unsubscribed', unsubscribed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(device.id).run();
    await env.DB.prepare("UPDATE push_deliveries SET status=?, sent_at=?, error_message=? WHERE device_id=? AND deduplication_key=?")
      .bind(result.ok ? 'sent' : 'failed', result.ok ? new Date().toISOString() : null, result.error || null, device.id, deduplicationKey).run();
    if (result.ok) sent++;
    else failed++;
  }
  return { sent, failed };
};

const dispatchAdministratorMissingPicksAlert = async (env: Env, week: JsonObject): Promise<void> => {
  const weekId = Number(week.id);
  if (!Number.isInteger(weekId)) return;
  const games = (await env.DB.prepare("SELECT kickoff_at FROM games WHERE week_id=?").bind(weekId).all<{ kickoff_at: string }>()).results;
  const kickoff = Math.min(...games.map(game => Date.parse(game.kickoff_at)).filter(Number.isFinite));
  if (!Number.isFinite(kickoff) || Date.now() < kickoff - 20 * 60_000 || Date.now() >= kickoff) return;
  const missing = await env.DB.prepare(
    `SELECT canonical_name FROM players
     WHERE NOT EXISTS (SELECT 1 FROM submissions WHERE submissions.week_id=? AND submissions.player_id=players.id AND submissions.superseded_at IS NULL)
     ORDER BY canonical_name COLLATE NOCASE`,
  ).bind(weekId).all<{ canonical_name: string }>();
  if (!missing.results.length) return;
  const names = missing.results.map(row => row.canonical_name);
  const listed = names.slice(0, 20).join(', ');
  const overflow = names.length > 20 ? ` and ${names.length - 20} more` : '';
  await sendAdministratorPushOnce(env, 'adminMissingPicks', `admin-missing-picks:${weekId}:20`, `Picks not in yet - Week ${week.week}`, `${listed}${overflow} have not submitted. 20 min until kickoff.`, `${env.PUBLIC_SITE_URL || 'https://fbp26.github.io/fbp-stats/'}#enter-picks`, weekId);
};

const sendAdministratorPushEvent = async (payload: JsonObject, env: Env): Promise<Response> => {
  if (!env.EMAIL_RELAY_SECRET?.trim() || cleanText(payload.secret, 200) !== env.EMAIL_RELAY_SECRET.trim()) return json({ ok: false, error: "Unauthorized." }, 401, env.CORS_ORIGIN);
  const title = cleanText(payload.title, 80), body = cleanText(payload.body, 240);
  if (!title || !body) return json({ ok: false, error: "An administrator notification needs a title and body." }, 400, env.CORS_ORIGIN);
  return json({ ok: true, ...await sendAdministratorPush(env, title, body, String(payload.url || "")) }, 200, env.CORS_ORIGIN);
};

const sendPushTest = async (request: Request, payload: JsonObject, env: Env): Promise<Response> => {
  const token = env.ADMIN_PUSH_TEST_TOKEN;
  if (!token || request.headers.get("Authorization") !== `Bearer ${token}`) return json({ ok: false, error: "Unauthorized." }, 401, env.CORS_ORIGIN);
  const playerName = await notificationPlayerName(payload.playerName, env);
  const kind = cleanText(payload.kind, 20);
  const siteUrl = env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/";
  if (kind === "admin") {
    return json({ ok: true, kind, ...await sendAdministratorPush(env, "Picks not in yet (20 min)", "A Price, Buster, Khloufe, JLew, Nils, and 2 more have not submitted.", `${siteUrl}#enter-picks`) }, 200, env.CORS_ORIGIN);
  }
  if (!["player-first", "player-top-ten"].includes(kind)) return json({ ok: false, error: "Choose an admin, player-first, or player-top-ten sample." }, 400, env.CORS_ORIGIN);
  const device = await env.DB.prepare(
    `SELECT devices.id, devices.endpoint, devices.p256dh, devices.auth
     FROM push_devices devices JOIN push_device_players players ON players.device_id=devices.id
     WHERE devices.status='active' AND players.player_name=? COLLATE NOCASE
     ORDER BY players.linked_at DESC LIMIT 1`,
  ).bind(playerName).first<{ id: number; endpoint: string; p256dh: string; auth: string }>();
  if (!device) return json({ ok: false, error: "No active Push device is linked to that player." }, 404, env.CORS_ORIGIN);
  const result = await sendWebPush(
    device,
    { title: kind === "player-first" ? "You jumped into 1st - Week 5" : "You reached the top 10 - Week 5", body: kind === "player-first" ? "Mel is 1st at 8-2. ✓ PIT (PIT 20-NE 10) · ✓ CLE (CLE 17-TEN 14) · x DEN (DEN 10-SF 17)." : "You are 7th at 6-4, up from 14th. SF scored a TD and is now covering DEN. Your win outlook improved from 4.05% to 23.54%.", url: `${siteUrl}#live-analysis`, tag: `fbp-player-sample-${crypto.randomUUID()}` },
    { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: env.VAPID_SUBJECT! },
  );
  if (result.expired) await env.DB.prepare("UPDATE push_devices SET status='unsubscribed', unsubscribed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(device.id).run();
  return json({ ok: result.ok, kind, sent: result.ok ? 1 : 0, failed: result.ok ? 0 : 1, error: result.error || "" }, result.ok ? 200 : 502, env.CORS_ORIGIN);
};

const savePushDevice = async (payload: JsonObject, env: Env): Promise<Response> => {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return json({ ok: false, error: "Push notifications are not configured yet." }, 503, env.CORS_ORIGIN);
  const subscription = pushSubscriptionFromPayload(payload.subscription);
  const preferences = parseNotificationPreferences(payload.preferences);
  if (!notificationEvents.some(event => preferences[event])) return json({ ok: false, error: "Choose at least one alert." }, 400, env.CORS_ORIGIN);
  const existing = await env.DB.prepare("SELECT device_token FROM push_devices WHERE endpoint = ?").bind(subscription.endpoint).first<{ device_token: string }>();
  const deviceToken = existing?.device_token || randomToken();
  const values = notificationEvents.map(event => preferences[event] ? 1 : 0);
  await env.DB.prepare(
    `INSERT INTO push_devices
    (endpoint, p256dh, auth, device_token, device_token_hash, status, picks_ready, picks_due, picks_due_minutes, first_place, top_five, top_ten, lead_change, early_window, late_window, before_snf, before_mnf, weekly_result, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, status='active',
       picks_ready=excluded.picks_ready, picks_due=excluded.picks_due, picks_due_minutes=excluded.picks_due_minutes,
      first_place=excluded.first_place, top_five=excluded.top_five, top_ten=excluded.top_ten, lead_change=excluded.lead_change, early_window=excluded.early_window, late_window=excluded.late_window,
       before_snf=excluded.before_snf, before_mnf=excluded.before_mnf, weekly_result=excluded.weekly_result,
       unsubscribed_at=NULL, updated_at=CURRENT_TIMESTAMP`,
  ).bind(subscription.endpoint, subscription.p256dh, subscription.auth, deviceToken, await sha256(deviceToken), values[0], values[1], reminderMinutes(payload.picksDueMinutes), ...values.slice(2)).run();
  await sendAdministratorPush(env, existing ? "FBP push preferences updated" : "FBP push notifications enabled", existing ? "A device changed its FBP notification preferences." : "A device enabled FBP push notifications.");
  return json({ ok: true, deviceToken, status: "active" }, 200, env.CORS_ORIGIN);
};

const linkPushDevicePlayer = async (payload: JsonObject, env: Env): Promise<Response> => {
  const deviceToken = cleanText(payload.deviceToken, 64);
  if (!/^[a-f0-9]{64}$/.test(deviceToken)) return json({ ok: false, error: "Push notifications are not enabled on this device." }, 404, env.CORS_ORIGIN);
  const playerName = await notificationPlayerName(payload.playerName, env);
  const device = await env.DB.prepare("SELECT id FROM push_devices WHERE device_token_hash = ? AND status = 'active'").bind(await sha256(deviceToken)).first<{ id: number }>();
  if (!device) return json({ ok: false, error: "Push notifications are no longer active on this device." }, 404, env.CORS_ORIGIN);
  const linked = await env.DB.prepare("INSERT INTO push_device_players (device_id, player_name) VALUES (?, ?) ON CONFLICT(device_id, player_name) DO NOTHING").bind(device.id, playerName).run();
  if (linked.meta.changes) await sendAdministratorPush(env, "FBP notifications linked", `${playerName} enabled notifications on this device.`);
  return json({ ok: true, playerName }, 200, env.CORS_ORIGIN);
};

const disablePushDevice = async (payload: JsonObject, env: Env): Promise<Response> => {
  const deviceToken = cleanText(payload.deviceToken, 64);
  if (!/^[a-f0-9]{64}$/.test(deviceToken)) return json({ ok: false, error: "Push notifications are not enabled on this device." }, 404, env.CORS_ORIGIN);
  const result = await env.DB.prepare("UPDATE push_devices SET status='unsubscribed', unsubscribed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE device_token_hash=? AND status='active'").bind(await sha256(deviceToken)).run();
  return result.meta.changes ? json({ ok: true, status: "unsubscribed" }, 200, env.CORS_ORIGIN) : json({ ok: false, error: "Push notifications are already disabled." }, 404, env.CORS_ORIGIN);
};

export const loadAlertFeed = async (env: Env, week: JsonObject, fetcher: typeof fetch = fetch): Promise<AlertFeed> => {
  const control = await env.DB.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
  if (!control || !['SHEETS', 'D1'].includes(control.owner)) throw new Error('Pool ownership unavailable; alerts withheld.');
  if (week.phase !== 'REGULAR_SEASON') throw new Error('Regular-season alerts cannot publish playoff picks.');
  let data: JsonObject;
  if (control.owner === 'D1') {
    data = await buildCurrentWeek(env.DB, week);
  } else {
    if (!env.PICKS_SOURCE_URL) throw new Error("Authoritative picks feed is not configured.");
    const url = new URL(env.PICKS_SOURCE_URL);
    url.search = new URLSearchParams({ action: "current-week", fast: "1", _: String(Date.now()) }).toString();
    const response = await fetcher(url, { signal: AbortSignal.timeout(50000), cache: "no-store" });
    if (!response.ok) throw new Error("Authoritative picks feed unavailable; alerts withheld.");
    data = await response.json() as JsonObject;
    if (data.staged !== true) throw new Error("No active staged picks; alerts withheld.");
  }
  const feed = parseAlertFeed(data, Number(week.season), Number(week.week));
  const approved = await getWeekConfig(env.DB, Number(week.id));
  if (feed.games.length !== approved.length || feed.games.some(game => !approved.some(row => String(row.gameId) === game.gameId && String(row.favorite).toUpperCase() === game.favorite && String(row.underdog).toUpperCase() === game.underdog && Number(row.spread) === game.spread))) throw new Error("Live slate does not match the approved slate; alerts withheld.");
  const currentOwner = await env.DB.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
  if (currentOwner?.owner !== control.owner || currentOwner.epoch !== control.epoch) throw new Error('Pool ownership changed; alerts withheld.');
  return feed;
};

const sendRelayEmail = async (env: Env, to: string, subject: string, body: string, htmlBody = ""): Promise<boolean> => {
  if (!env.EMAIL_RELAY_URL?.trim() || !env.EMAIL_RELAY_SECRET?.trim()) return false;
  const response = await fetch(env.EMAIL_RELAY_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ action: "send-notification-email", secret: env.EMAIL_RELAY_SECRET, to, subject, body, htmlBody }),
  });
  const result = await response.json().catch(() => null) as { ok?: boolean } | null;
  return response.ok && result?.ok === true;
};

export const dispatchSubmissionConfirmationOutbox = async (db: D1Database, send: (to: string, subject: string, body: string) => Promise<boolean>, limit = 20) => {
  let sent = 0, failed = 0;
  for (let index = 0; index < limit; index++) {
    const row = await db.prepare(`SELECT id,destination,payload_json FROM submission_confirmation_outbox
      WHERE status IN ('queued','failed') ORDER BY created_at,id LIMIT 1`).first<{id:number;destination:string;payload_json:string}>();
    if (!row) break;
    const claimed = await db.prepare("UPDATE submission_confirmation_outbox SET status='sending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','failed')")
      .bind(row.id).run();
    if (!claimed.meta.changes) continue;
    const payload = JSON.parse(row.payload_json) as { name: string; season: number; week: number; phase: string; weekName: string; picks?: string[]; bestBet: string; tiebreaker?: number; submittedAt: string; confirmationText?: string };
    const subject = `FBP Week ${payload.week}: ${payload.name} submitted picks`;
    const fallback = [
      `${payload.name} submitted picks for ${payload.season} Week ${payload.week}.`,
      `Week name: ${payload.weekName}`,
      `Best Bet: ${payload.bestBet}`,
      `Tiebreaker: ${payload.tiebreaker ?? "-"}`,
      `Submitted: ${payload.submittedAt}`,
      payload.picks?.length ? `Picks: ${payload.picks.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    const body = payload.confirmationText?.trim()
      ? `${fallback}\n\nConfirmation details\n${payload.confirmationText.trim()}`
      : fallback;
    let delivered = false;
    try { delivered = await send(row.destination, subject, body); } catch { delivered = false; }
    await db.prepare(`UPDATE submission_confirmation_outbox SET status=?,attempts=attempts+1,last_error=?,sent_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='sending'`)
      .bind(delivered ? 'sent' : 'failed', delivered ? null : 'Email relay rejected the confirmation.', delivered ? new Date().toISOString() : null, row.id).run();
    if (delivered) sent++; else { failed++; break; }
  }
  return { sent, failed };
};

const subscribeNotifications = async (request: Request, payload: JsonObject, env: Env): Promise<Response> => {
  const channel = cleanText(payload.channel, 10) as NotificationChannel;
  if (channel !== "email" && channel !== "sms") return json({ ok: false, error: "Choose email or text." }, 400, env.CORS_ORIGIN);
  if (channel === "sms") return json({ ok: false, error: "Text alerts are not available yet. No phone number was saved." }, 503, env.CORS_ORIGIN);
  if (!env.EMAIL_RELAY_URL?.trim() || !env.EMAIL_RELAY_SECRET?.trim()) {
    return json({ ok: false, error: "Email alerts are temporarily unavailable while sender setup is completed." }, 503, env.CORS_ORIGIN);
  }
  const playerName = await notificationPlayerName(payload.playerName, env);
  if (!playerName) return json({ ok: false, error: "Choose the player these alerts should follow." }, 400, env.CORS_ORIGIN);
  const normalizedDestination = normalizeNotificationDestination(channel, payload.destination);
  const preferences = parseNotificationPreferences(payload.preferences);
  const picksDueMinutes = reminderMinutes(payload.picksDueMinutes);
  if (!notificationEvents.some((event) => preferences[event])) {
    return json({ ok: false, error: "Choose at least one alert." }, 400, env.CORS_ORIGIN);
  }
  const existing = await env.DB.prepare(
    "SELECT verification_sent_at FROM notification_subscriptions WHERE channel = ? AND normalized_destination = ?",
  ).bind(channel, normalizedDestination).first<{ verification_sent_at: string | null }>();
  if (existing?.verification_sent_at && Date.now() - Date.parse(existing.verification_sent_at) < 5 * 60 * 1000) {
    return json({ ok: false, error: "A verification email was sent recently. Check your inbox or try again in five minutes." }, 429, env.CORS_ORIGIN);
  }
  const verificationToken = randomToken(), manageToken = randomToken();
  const values = notificationEvents.map((event) => preferences[event] ? 1 : 0);
  await env.DB.prepare(
    `INSERT INTO notification_subscriptions
     (player_name, channel, destination, normalized_destination, status, verification_token_hash, manage_token_hash, manage_token,
      picks_ready, picks_due, picks_due_minutes, first_place, early_window, late_window, before_snf, before_mnf, weekly_result, verification_sent_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (channel, normalized_destination) DO UPDATE SET
       player_name = excluded.player_name, destination = excluded.destination, status = 'pending',
       verification_token_hash = excluded.verification_token_hash, manage_token_hash = excluded.manage_token_hash, manage_token = excluded.manage_token,
      picks_ready = excluded.picks_ready, picks_due = excluded.picks_due, picks_due_minutes = excluded.picks_due_minutes, first_place = excluded.first_place, early_window = excluded.early_window,
       late_window = excluded.late_window, before_snf = excluded.before_snf, before_mnf = excluded.before_mnf,
       weekly_result = excluded.weekly_result, verification_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
       verified_at = NULL, unsubscribed_at = NULL`,
  ).bind(playerName, channel, normalizedDestination, normalizedDestination, await sha256(verificationToken), await sha256(manageToken), manageToken, values[0], values[1], picksDueMinutes, ...values.slice(2)).run();
  const workerOrigin = new URL(request.url).origin;
  const verifyUrl = `${workerOrigin}/?action=verify-notifications&token=${verificationToken}`;
  const stopUrl = `${workerOrigin}/?action=unsubscribe-notifications&token=${manageToken}`;
  const requestedAt = env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/";
  const sent = await sendRelayEmail(env, normalizedDestination, "Verify your FBP alerts",
    `Confirm alerts for ${playerName}:\n\n${verifyUrl}\n\nYou requested alerts at ${requestedAt}\n\nStop these alerts: ${stopUrl}`,
    `<p><a href="${escapeHtml(verifyUrl)}" style="display:inline-block;padding:13px 20px;background:#ffcf40;color:#17212b;border-radius:5px;text-decoration:none;font-weight:bold">Verify email</a></p>${alertEmailHtml(`Confirm FBP alerts for ${playerName}`, "Verify this email address to activate your selected alerts.", requestedAt, stopUrl)}`);
  if (!sent) {
    await env.DB.prepare(
      "UPDATE notification_subscriptions SET verification_token_hash = NULL, verification_sent_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE channel = ? AND normalized_destination = ? AND status = 'pending'",
    ).bind(channel, normalizedDestination).run();
    return json({ ok: false, error: "The verification email could not be sent. Try again later." }, 502, env.CORS_ORIGIN);
  }
  return json({ ok: true, status: "pending", maskedDestination: maskNotificationDestination(channel, normalizedDestination) }, 202, env.CORS_ORIGIN);
};

const updateNotificationPreferences = async (payload: JsonObject, env: Env): Promise<Response> => {
  const manageToken = cleanText(payload.manageToken, 64);
  if (!/^[a-f0-9]{64}$/.test(manageToken)) return json({ ok: false, error: "This alert-management link is invalid." }, 400, env.CORS_ORIGIN);
  const playerName = await notificationPlayerName(payload.playerName, env);
  if (!playerName) return json({ ok: false, error: "Choose the player these alerts should follow." }, 400, env.CORS_ORIGIN);
  const preferences = parseNotificationPreferences(payload.preferences);
  if (!notificationEvents.some((event) => preferences[event])) return json({ ok: false, error: "Choose at least one alert." }, 400, env.CORS_ORIGIN);
  const picksDueMinutes = reminderMinutes(payload.picksDueMinutes);
  const values = notificationEvents.map((event) => preferences[event] ? 1 : 0);
  const result = await env.DB.prepare(
    `UPDATE notification_subscriptions SET player_name = ?, picks_ready = ?, picks_due = ?, picks_due_minutes = ?,
      first_place = ?, early_window = ?, late_window = ?, before_snf = ?, before_mnf = ?, weekly_result = ?, updated_at = CURRENT_TIMESTAMP
     WHERE manage_token_hash = ? AND status = 'active'`,
  ).bind(playerName, values[0], values[1], picksDueMinutes, ...values.slice(2), await sha256(manageToken)).run();
  return result.meta.changes
    ? json({ ok: true, status: "active" }, 200, env.CORS_ORIGIN)
    : json({ ok: false, error: "This alert-management link has expired." }, 404, env.CORS_ORIGIN);
};

const notificationEventLabels: Record<NotificationEvent, string> = {
  picksReady: "Picks are ready",
  picksDue: "Picks due reminder",
  firstPlace: "First-place update",
  topFive: "Top-5 update",
  topTen: "Top-10 update",
  leadChange: "Lead change",
  earlyWindow: "Early games complete",
  lateWindow: "Late games complete",
  beforeSnf: "Before Sunday Night Football",
  beforeMnf: "Before Monday Night Football",
  weeklyResult: "Weekly result",
};

const notificationTimingExplanation = (event: NotificationEvent, picksDueMinutes: number): string => {
  const explanations: Record<NotificationEvent, string> = {
    picksReady: "all games and point spreads have been posted and locked",
    picksDue: `the first kickoff is about ${picksDueMinutes} minutes away and your picks are not in`,
    firstPlace: "your provisional total wins moved from below first into sole or shared first place",
    topFive: "your provisional rank moved into the top 5",
    topTen: "your provisional rank moved into the top 10",
    leadChange: "the pool lead changed",
    earlyWindow: "all Sunday 1 PM games are final",
    lateWindow: "the Sunday afternoon games are final",
    beforeSnf: "the Sunday afternoon games are final and Sunday Night Football starts within 35 minutes",
    beforeMnf: "Monday Night Football starts within 35 minutes",
    weeklyResult: "the week has been finalized",
  };
  return `Why you received this now: ${explanations[event]}. Alerts are checked every minute; score feeds refresh about every five minutes. Email delivery may take longer.`;
};

const weeklyStandingsSummary = (players: JsonObject[]): string => {
  if (!players.length) return "Current weekly standings\nNo player cards have been submitted yet.";
  const rows = players.map((player, index) => `${Number(player.rank) || index + 1}. ${player.name} — ${player.wins || 0}-${player.losses || 0}`);
  return `Current weekly standings\n${rows.join("\n")}`;
};

const scoreArchivedSeason = async (db: D1Database, week: Record<string, unknown>): Promise<{ before: SeasonStanding[]; after: SeasonStanding[] }> => {
  const archives = await db.prepare(`SELECT w.week,a.payload_json FROM completed_week_archives a JOIN weeks w ON w.id=a.week_id
    WHERE w.season=? AND w.phase='REGULAR_SEASON' AND w.week<=? ORDER BY w.week`).bind(week.season, week.week).all<{ week: number; payload_json: string }>();
  const before = new Map<string, Omit<SeasonStanding, "rank">>();
  const after = new Map<string, Omit<SeasonStanding, "rank">>();
  const addScores = (target: Map<string, Omit<SeasonStanding, "rank">>, payload: JsonObject): void => {
    const games = Array.isArray(payload.games) ? payload.games.map(value => {
      const game = value as JsonObject;
      return { favorite: String(game.favorite || ""), underdog: String(game.underdog || ""), spread: Number(game.spread), status: String(game.status || game.state || "PREGAME") as ScoringGame["status"], favoriteScore: Number(game.favoriteScore), underdogScore: Number(game.underdogScore) };
    }) : [];
    const cards = Array.isArray(payload.submissions) ? payload.submissions.map(value => {
      const submission = value as JsonObject;
      return { name: String(submission.name || ""), weekName: String(submission.weekName || ""), picks: Array.isArray(submission.picks) ? (submission.picks as unknown[]).map(String) : [], bestBet: String(submission.bestBet || ""), tiebreaker: Number(submission.tiebreaker) };
    }).filter(card => card.name && card.picks.length === games.length) : [];
    scoreWeekWithoutProbabilities(cards, games, Number(payload.actualTiebreaker)).forEach(player => {
      const key = player.name.toLowerCase();
      const record = target.get(key) || { name: player.name, wins: 0, losses: 0 };
      record.wins += player.wins;
      record.losses += player.losses;
      target.set(key, record);
    });
  };
  const rank = (records: Map<string, Omit<SeasonStanding, "rank">>): SeasonStanding[] => [...records.values()]
    .sort((left, right) => right.wins - left.wins || left.losses - right.losses || left.name.localeCompare(right.name))
    .map((record, index) => ({ ...record, rank: index + 1 }));
  for (const archive of archives.results) {
    const payload = JSON.parse(archive.payload_json) as JsonObject;
    if (Number(archive.week) < Number(week.week)) addScores(before, payload);
    if (Number(archive.week) === Number(week.week)) {
      before.forEach((record, key) => after.set(key, { ...record }));
      addScores(after, payload);
    }
  }
  return { before: rank(before), after: rank(after) };
};

const picksReadySummary = (games: JsonObject[], weekNumber: unknown): string => {
  const gameLines = games.flatMap((game, index) => {
    const home = String(game.homeTeam || "").toUpperCase();
    const displayTeam = (team: unknown): string => String(team || "").toUpperCase() === home
      ? String(team || "").toUpperCase()
      : String(team || "").toLowerCase();
    const kickoff = new Date(String(game.kickoff || ""));
    const date = Number.isNaN(kickoff.getTime()) ? "Date TBD" : kickoff.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric" });
    const time = Number.isNaN(kickoff.getTime()) ? "Time TBD" : kickoff.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    return [`${index + 1}. ${displayTeam(game.favorite)}   ${Number(game.spread)}   ${displayTeam(game.underdog)}`, `   ${date} · ${time}`, ""];
  });
  return `${games.length} games and their point spreads are posted for Week ${weekNumber} and will not change.\n\n${gameLines.join("\n").trimEnd()}`;
};

interface NotificationDispatchResult {
  sent: number;
  skipped: number;
  failed: number;
}

export const dispatchWeekNotifications = async (
  env: Env,
  week: Record<string, unknown>,
  onlyEvents?: Set<NotificationEvent>,
): Promise<NotificationDispatchResult> => {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (!env.EMAIL_RELAY_URL?.trim() || !env.EMAIL_RELAY_SECRET?.trim()) return result;
  const feed = onlyEvents ? null : await loadAlertFeed(env, week);
  const games: JsonObject[] = feed ? feed.games.map(game => ({ ...game, state: game.status })) : await getWeekConfig(env.DB, Number(week.id));
  const now = new Date();
  const eventSet = onlyEvents || new Set(scheduledNotificationEvents(now, games, String(week.status)));
  const players: JsonObject[] = feed ? scoreWeekWithoutProbabilities(feed.cards, feed.games, null).map(player => ({ ...player })) : [];
  players.forEach(player => { player.rank = 1 + players.filter(other => Number(other.wins) > Number(player.wins)).length; });
  players.sort((left, right) => Number(left.rank) - Number(right.rank));
  let observation: AlertObservation | null = null;
  let previousObservation: AlertObservation | null = null;
  if (feed) {
    const previous = await env.DB.prepare("SELECT payload_json FROM notification_observations WHERE week_id = ?").bind(week.id).first<{ payload_json: string }>();
    previousObservation = previous ? JSON.parse(previous.payload_json) as AlertObservation : null;
    observation = observeLeads(feed, previousObservation, now.toISOString());
    await env.DB.prepare("INSERT INTO notification_observations (week_id, observed_at, payload_json) VALUES (?, ?, ?) ON CONFLICT (week_id) DO UPDATE SET observed_at = excluded.observed_at, payload_json = excluded.payload_json").bind(week.id, observation.at, JSON.stringify(observation)).run();
  }
  const hasStarted = games.some((game) => ["LIVE", "FINAL"].includes(String(game.state)));
  if (!onlyEvents && hasStarted && players.length) eventSet.add("firstPlace");
  const subscriptions = await env.DB.prepare(
    "SELECT * FROM notification_subscriptions WHERE status = 'active' AND channel = 'email' AND manage_token IS NOT NULL",
  ).all();
  const publicApiUrl = (env.PUBLIC_API_URL || "https://fbp-api.fbp-api-worker.workers.dev").replace(/\/$/, "");
  for (const subscription of subscriptions.results) {
    const followedName = String(subscription.player_name);
    const followed = players.find((player) => String(player.name).toLowerCase() === followedName.toLowerCase());
    const rank = followed ? Number(followed.rank) : 0;
    const lead = followed && observation?.changes[String(followed.name)];
    const subscriptionEvents = new Set(eventSet);
    if (!onlyEvents && picksDueReminderIsEligible(now, games, hasStarted ? "live" : "staged", Number(subscription.picks_due_minutes) || 60)) subscriptionEvents.add("picksDue");
    for (const event of subscriptionEvents) {
      if (!Number(subscription[notificationPreferenceColumns[event]])) continue;
      if (event === "picksDue" && (followed || followedName === "FBP pool")) continue;
      const activatedAt = String(subscription.verified_at || subscription.created_at || "");
      if (event === "firstPlace" && (!followed || rank !== 1 || !lead || Date.parse(lead.at) < Date.parse(activatedAt.endsWith("Z") ? activatedAt : `${activatedAt}Z`))) continue;
      const paths = (event === "beforeSnf" || event === "beforeMnf") && feed && followed ? nightPaths(feed, String(followed.name)) : null;
      if ((event === "beforeSnf" || event === "beforeMnf") && !paths?.eligible) continue;
      const deduplicationKey = `${event}:${week.id}${event === "firstPlace" && lead ? `:${lead.at}` : ""}`;
      const reserved = await env.DB.prepare(
        `INSERT INTO notification_deliveries (subscription_id, week_id, event_type, deduplication_key, status)
         VALUES (?, ?, ?, ?, 'queued') ON CONFLICT (subscription_id, deduplication_key) DO NOTHING`,
      ).bind(subscription.id, week.id, event, deduplicationKey).run();
      if (!reserved.meta.changes) {
        const prior = await env.DB.prepare(
          "SELECT status FROM notification_deliveries WHERE subscription_id = ? AND deduplication_key = ?",
        ).bind(subscription.id, deduplicationKey).first<{ status: string }>();
        if (prior?.status !== "failed") {
          result.skipped += 1;
          continue;
        }
        await env.DB.prepare(
          "UPDATE notification_deliveries SET status = 'queued', error_message = NULL WHERE subscription_id = ? AND deduplication_key = ?",
        ).bind(subscription.id, deduplicationKey).run();
      }
      const standings = weeklyStandingsSummary(players);
      const stopUrl = `${publicApiUrl}/?action=unsubscribe-notifications&token=${subscription.manage_token}`;
      const firstKickoff = games.map((game) => Date.parse(String(game.kickoff || ""))).filter(Number.isFinite).sort((left, right) => left - right)[0];
      let eventSummary = event === "picksDue"
        ? `${followedName}, your Week ${week.week} picks are not in yet.\n\nFirst kickoff: ${new Date(firstKickoff).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}\nSubmit before kickoff to avoid missing the opening game.`
        : event === "picksReady" ? picksReadySummary(games, week.week) : standings;
      if (event === "firstPlace" && lead && observation) {
        const when = new Date(lead.at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
        const journey = observation.history.filter(frame => frame.ranks[String(followed?.name)] != null).slice(-12).map(frame => `${new Date(frame.at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })}: #${frame.ranks[String(followed?.name)]}`).join(" -> ");
        eventSummary = `${followedName}, you moved from #${lead.from} to ${lead.tied ? "shared" : "sole"} first with ${lead.wins} wins.\nObserved ${when}. This is the check time, not an exact play timestamp.\n\nChanges since the preceding check:\n${lead.events.join("\n") || "The submitted field changed; no new game score was observed."}\n\nYour recent rank journey (Eastern):\n${journey}\n\nLive scores are provisional; Best Bets count twice.\n\n${standings}`;
      }
      if (paths && followed) eventSummary = `${followedName}, you are still in the running. Your tiebreak guess: ${followed.tiebreaker} net passing yards.\n\n${paths.count} of ${paths.total} possible remaining ATS combinations leave you first or tied for first (counts, not odds).\n${paths.examples.join("\n")}\n${paths.count > paths.examples.length ? `Showing ${paths.examples.length} examples; open FBP for all scenarios.` : ""}\n\nCovers use the locked pool spreads; pushes add no wins. Ties use the closest guess to the final game's combined net passing yards; equal differences share first.\n\n${standings}`;
      const timingExplanation = notificationTimingExplanation(event, Number(subscription.picks_due_minutes) || 60);
      const siteUrl = `${env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/"}#${event === "picksReady" || event === "picksDue" ? "enter-picks" : "live-analysis"}`;
      const subject = `FBP Week ${week.week}: ${notificationEventLabels[event]}`;
      const message = `${eventSummary}\n\n${timingExplanation}`;
      const sent = await sendRelayEmail(env, String(subscription.destination),
        subject, `${message}\n\nOpen FBP: ${siteUrl}\n\nStop all FBP alerts: ${stopUrl}`,
        alertEmailHtml(subject, message, siteUrl, stopUrl));
      await env.DB.prepare(
        "UPDATE notification_deliveries SET status = ?, sent_at = ?, error_message = ? WHERE subscription_id = ? AND deduplication_key = ?",
      ).bind(sent ? "sent" : "failed", sent ? new Date().toISOString() : null, sent ? null : "Email relay rejected the message.", subscription.id, deduplicationKey).run();
      if (sent) result.sent += 1;
      else result.failed += 1;
    }
  }
  return result;
};

const pushDestination = (event: NotificationEvent): string => {
  if (event === "picksReady" || event === "picksDue") return "enter-picks";
  return "live-analysis";
};

const pushStartedPickSummary = (feed: AlertFeed | null, playerName: string): string => {
  const card = feed?.cards.find(candidate => candidate.name.toLowerCase() === playerName.toLowerCase());
  if (!feed || !card) return "";
  return feed.games.map((game, index) => ({ game, pick: card.picks[index] })).filter(({ game }) => game.status !== "PREGAME").map(({ game, pick }) => {
    const outcome = atsOutcome(game);
    const marker = outcome === pick ? "✓" : outcome ? "x" : "•";
    return `${marker} ${pick} (${game.favorite} ${game.favoriteScore}-${game.underdog} ${game.underdogScore})`;
  }).join(" · ");
};

const dispatchPushNotifications = async (
  env: Env,
  week: Record<string, unknown>,
  onlyEvents?: Set<NotificationEvent>,
): Promise<NotificationDispatchResult> => {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return result;
  const feed = onlyEvents ? null : await loadAlertFeed(env, week);
  const games: JsonObject[] = feed ? feed.games.map(game => ({ ...game, state: game.status })) : await getWeekConfig(env.DB, Number(week.id));
  const now = new Date();
  const events = onlyEvents || new Set(scheduledNotificationEvents(now, games, String(week.status)));
  const players: JsonObject[] = feed ? scoreWeekWithoutProbabilities(feed.cards, feed.games, null).map(player => ({ ...player })) : [];
  players.forEach(player => { player.rank = 1 + players.filter(other => Number(other.wins) > Number(player.wins)).length; });
  let observation: AlertObservation | null = null;
  let previousObservation: AlertObservation | null = null;
  if (feed) {
    const previous = await env.DB.prepare("SELECT payload_json FROM notification_observations WHERE week_id = ?").bind(week.id).first<{ payload_json: string }>();
    previousObservation = previous ? JSON.parse(previous.payload_json) as AlertObservation : null;
    observation = observeLeads(feed, previousObservation, now.toISOString());
    await env.DB.prepare("INSERT INTO notification_observations (week_id, observed_at, payload_json) VALUES (?, ?, ?) ON CONFLICT (week_id) DO UPDATE SET observed_at = excluded.observed_at, payload_json = excluded.payload_json").bind(week.id, observation.at, JSON.stringify(observation)).run();
  }
  const weeklyRecapReady = String(week.status) === "finalized" && Boolean(
    await env.DB.prepare("SELECT 1 FROM completed_week_archives WHERE week_id = ?").bind(week.id).first(),
  );
  const seasonStandings = events.has("weeklyResult") && weeklyRecapReady ? await scoreArchivedSeason(env.DB, week) : null;
  const hasStarted = games.some(game => ["LIVE", "FINAL"].includes(String(game.state)));
  if (!onlyEvents && hasStarted && players.length) events.add("firstPlace").add("topFive").add("topTen").add("leadChange");
  const devices = await env.DB.prepare("SELECT * FROM push_devices WHERE status = 'active'").all();
  const playerNames = new Set(players.map(player => String(player.name).toLowerCase()));
  for (const device of devices.results) {
    const linked = await env.DB.prepare("SELECT player_name FROM push_device_players WHERE device_id = ? ORDER BY player_name COLLATE NOCASE").bind(device.id).all<{ player_name: string }>();
    const names = linked.results.map(row => row.player_name);
    const submitted = names.filter(name => playerNames.has(name.toLowerCase()));
    const missing = names.filter(name => !playerNames.has(name.toLowerCase()));
    const deviceEvents = new Set(events);
    if (!onlyEvents && picksDueReminderIsEligible(now, games, hasStarted ? "live" : "staged", Number(device.picks_due_minutes) || 60)) deviceEvents.add("picksDue");
    for (const event of deviceEvents) {
      if (!Number(device[notificationPreferenceColumns[event]])) continue;
      if (event === "picksDue" && !missing.length) continue;
      const leaders = submitted.filter(name => players.find(player => String(player.name).toLowerCase() === name.toLowerCase() && Number(player.rank) === 1));
      const newLeaders = leaders.filter(name => {
        const player = players.find(row => String(row.name).toLowerCase() === name.toLowerCase());
        const lead = player && observation?.changes[String(player.name)];
        const createdAt = Date.parse(`${String(device.created_at || "").replace(/Z$/, "")}Z`);
        return lead && (!Number.isFinite(createdAt) || Date.parse(lead.at) >= createdAt);
      });
      const topFive = submitted.filter(name => Number(observation?.ranks[name]) <= 5 && Number(previousObservation?.ranks[name]) > 5);
      const topTen = submitted.filter(name => Number(observation?.ranks[name]) <= 10 && Number(previousObservation?.ranks[name]) > 10);
      const currentLeaders = players.filter(player => Number(player.rank) === 1).map(player => String(player.name));
      const priorLeaders = Object.entries(previousObservation?.ranks || {}).filter(([, rank]) => rank === 1).map(([name]) => name);
      const newPoolLeaders = currentLeaders.filter(name => !priorLeaders.includes(name));
      if (event === "firstPlace" && !newLeaders.length) continue;
      if (event === "topFive" && !topFive.length) continue;
      if (event === "topTen" && !topTen.length) continue;
      if (event === "leadChange" && (!previousObservation || !newPoolLeaders.length)) continue;
      if (["earlyWindow", "lateWindow", "beforeSnf", "beforeMnf", "weeklyResult"].includes(event) && !submitted.length) continue;
      if (event === "weeklyResult" && !weeklyRecapReady) continue;
      const paths = (event === "beforeSnf" || event === "beforeMnf") && feed
        ? submitted.map(name => ({ name, paths: nightPaths(feed, name) })).filter(candidate => candidate.paths.eligible)
        : [];
      if ((event === "beforeSnf" || event === "beforeMnf") && !paths.length) continue;
      const transitionNames = event === "firstPlace" ? newLeaders : event === "topFive" ? topFive : event === "topTen" ? topTen : event === "leadChange" ? newPoolLeaders : [];
      const key = `${event}:${week.id}${transitionNames.length ? `:${observation?.at}:${transitionNames.join(",")}` : ""}`;
      const reserved = await env.DB.prepare("INSERT INTO push_deliveries (device_id, week_id, event_type, deduplication_key, status) VALUES (?, ?, ?, ?, 'queued') ON CONFLICT(device_id, deduplication_key) DO NOTHING").bind(device.id, week.id, event, key).run();
      if (!reserved.meta.changes) { result.skipped += 1; continue; }
      const personalResults = submitted.map(name => {
        const player = players.find(row => String(row.name).toLowerCase() === name.toLowerCase())!;
        const tied = players.filter(row => Number(row.wins) === Number(player.wins)).length > 1;
        return `${name}: ${Number(player.wins)} wins, ${tied ? "tied for " : ""}${ordinalRank(Number(player.rank))}`;
      });
      const primaryName = submitted[0] || "";
      const primaryPlayer = players.find(row => String(row.name).toLowerCase() === primaryName.toLowerCase());
      const startedPicks = pushStartedPickSummary(feed, primaryName);
      const previousRank = Number(previousObservation?.ranks[primaryName]);
      const standing = primaryPlayer ? `${primaryName} is ${ordinalRank(Number(primaryPlayer.rank))} at ${Number(primaryPlayer.wins)}-${Number(primaryPlayer.losses)}.` : "";
      const body = event === "picksDue"
        ? `Week ${week.week}: your card is missing. ${Number(device.picks_due_minutes) || 60} min until kickoff.`
        : event === "picksReady" ? `Week ${week.week} is open. Make your picks before the first kickoff.`
        : event === "firstPlace" ? `${standing}${startedPicks ? ` ${startedPicks}` : ""}`
        : event === "topFive" || event === "topTen" ? `${standing}${Number.isFinite(previousRank) ? ` Moved from ${ordinalRank(previousRank)}.` : ""}${startedPicks ? ` ${startedPicks}` : ""}`
        : event === "leadChange" ? `${newPoolLeaders.join(" and ")} moved into first. ${startedPicks}`.trim()
        : event === "weeklyResult" ? `${weeklyRecapMessage(players.map(player => ({ name: String(player.name), wins: Number(player.wins), losses: Number(player.losses), rank: Number(player.rank), tiebreakDifference: player.tiebreakDifference != null && Number.isFinite(Number(player.tiebreakDifference)) ? Number(player.tiebreakDifference) : null })), submitted)}\n${submitted.map(name => seasonRankMovementSummary(seasonStandings?.before.find(standing => standing.name.toLowerCase() === name.toLowerCase()) || null, seasonStandings?.after.find(standing => standing.name.toLowerCase() === name.toLowerCase()) || null)).join(" ")}`
        : event === "beforeSnf" || event === "beforeMnf" ? `You are still in the hunt. ${paths.map(candidate => `${candidate.name}: ${candidate.paths.count}/${candidate.paths.total} paths to first`).join("; ")}.`
        : `Your Current Week: ${personalResults.join("; ")}.`;
      const sent = await sendWebPush(
        { endpoint: String(device.endpoint), p256dh: String(device.p256dh), auth: String(device.auth) },
        { title: event === "picksDue" ? "Picks not in yet" : event === "picksReady" ? `Week ${week.week} picks are ready` : event === "firstPlace" ? `You jumped into 1st - Week ${week.week}` : event === "topFive" ? `You reached the top 5 - Week ${week.week}` : event === "topTen" ? `You reached the top 10 - Week ${week.week}` : event === "leadChange" ? `New pool leader - Week ${week.week}` : event === "weeklyResult" ? `Week ${week.week} final standings` : `Week ${week.week} update`, body, url: `${env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/"}#${pushDestination(event)}`, tag: `fbp-${key}` },
        { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT },
      );
      if (sent.expired) await env.DB.prepare("UPDATE push_devices SET status='unsubscribed', unsubscribed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(device.id).run();
      await env.DB.prepare("UPDATE push_deliveries SET status=?, sent_at=?, error_message=? WHERE device_id=? AND deduplication_key=?").bind(sent.ok ? "sent" : "failed", sent.ok ? new Date().toISOString() : null, sent.error || null, device.id, key).run();
      if (sent.ok) result.sent += 1;
      else result.failed += 1;
    }
  }
  return result;
};

export const syncApprovedStagedWeek = async (payload: JsonObject, env: Env): Promise<Record<string, unknown>> => {
  const control = await env.DB.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
  if (control?.owner !== 'SHEETS') throw new SubmissionError('Legacy staging is disabled while D1 owns the pool.');
  const season = Number(payload.season), weekNumber = Number(payload.week);
  if (!Number.isInteger(season) || !Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 18) {
    throw new Error("A valid regular-season season and week are required.");
  }
  const games = Array.isArray(payload.games) ? payload.games as JsonObject[] : [];
  if (!games.length || games.length > 16) throw new Error("The staged slate must contain between 1 and 16 games.");
  const normalizedGames = games.map((game, index) => {
    const externalId = cleanText(game.gameId || game.externalId, 100);
    const kickoff = cleanText(game.kickoff || game.startTime, 100);
    const favorite = cleanText(game.favorite, 20);
    const underdog = cleanText(game.underdog, 20);
    const home = cleanText(game.home || (game.homeTeam as JsonObject | undefined)?.abbreviation, 20);
    const away = cleanText(game.away || (game.awayTeam as JsonObject | undefined)?.abbreviation, 20);
    const spread = Number(game.spread);
    if (!externalId || !kickoff || !Number.isFinite(Date.parse(kickoff)) || !favorite || !underdog || !home || !away || !Number.isFinite(spread)) {
      throw new Error(`Game ${index + 1} is missing a valid ID, kickoff, matchup, or spread.`);
    }
    return { externalId, kickoff, favorite, underdog, home, away, spread, metadata: JSON.stringify(game) };
  });
  const existing = await findWeek(env.DB, season, weekNumber, "REGULAR_SEASON");
  if (existing) {
    if (existing.status === 'finalized') throw new SubmissionError('A finalized slate cannot be replaced.');
    const submissions = await env.DB.prepare("SELECT COUNT(*) AS count FROM submissions WHERE week_id = ? AND superseded_at IS NULL")
      .bind(existing.id).first<{ count: number }>();
    if (Number(submissions?.count)) throw new Error("The staged week already has picks and cannot be replaced by an approval link.");
  }
  const ownership = "EXISTS(SELECT 1 FROM admin_control WHERE owner='SHEETS' AND epoch=?)";
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE weeks SET status='finalized',finalized_at=COALESCE(finalized_at,CURRENT_TIMESTAMP)
      WHERE phase='REGULAR_SEASON' AND status!='finalized' AND NOT (season=? AND week=?) AND ${ownership}
      AND EXISTS(SELECT 1 FROM candidate_archives archive WHERE archive.season=weeks.season AND archive.week=weeks.week AND archive.phase=weeks.phase)`)
      .bind(season, weekNumber, control.epoch),
    env.DB.prepare(`INSERT INTO weeks(season,week,phase,status,tiebreak_game_id)
      SELECT ?,?,'REGULAR_SEASON','staged',? WHERE ${ownership}
      AND NOT EXISTS(SELECT 1 FROM weeks WHERE phase='REGULAR_SEASON' AND status!='finalized' AND NOT (season=? AND week=?))
      ON CONFLICT(season,week,phase) DO UPDATE SET status='staged',tiebreak_game_id=excluded.tiebreak_game_id
      WHERE weeks.status!='finalized' AND NOT EXISTS(SELECT 1 FROM submissions WHERE week_id=weeks.id)`)
      .bind(season, weekNumber, normalizedGames.at(-1)!.externalId, control.epoch, season, weekNumber),
    env.DB.prepare(`DELETE FROM games WHERE week_id IN (SELECT id FROM weeks WHERE season=? AND week=? AND phase='REGULAR_SEASON' AND status='staged')
      AND ${ownership} AND NOT EXISTS(SELECT 1 FROM submissions WHERE week_id=games.week_id)`)
      .bind(season, weekNumber, control.epoch),
  ];
  normalizedGames.forEach((game, index) => {
    statements.push(env.DB.prepare(
      `INSERT INTO games (week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team,metadata_json)
       SELECT id,?,?,?,?,?,?,?,?,? FROM weeks WHERE season=? AND week=? AND phase='REGULAR_SEASON' AND status='staged' AND ${ownership}
       AND NOT EXISTS(SELECT 1 FROM submissions WHERE week_id=weeks.id)`,
    ).bind(index, game.externalId, game.kickoff, game.favorite, game.underdog, game.spread, game.home, game.away, game.metadata, season, weekNumber, control.epoch));
  });
  await env.DB.batch(statements);
  const staged = await findWeek(env.DB, season, weekNumber, 'REGULAR_SEASON');
  const currentOwner = await env.DB.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
  if (!staged || staged.status !== 'staged' || currentOwner?.owner !== 'SHEETS' || currentOwner.epoch !== control.epoch) throw new SubmissionError('Staging was fenced by ownership or an unfinished prior week.');
  return staged;
};

const releasePicksReady = async (payload: JsonObject, env: Env): Promise<Response> => {
  if (!env.EMAIL_RELAY_SECRET?.trim() || cleanText(payload.secret, 200) !== env.EMAIL_RELAY_SECRET.trim()) {
    return json({ ok: false, error: "Unauthorized." }, 401, env.CORS_ORIGIN);
  }
  const week = await syncApprovedStagedWeek(payload, env);
  const result = await dispatchPushNotifications(env, week, new Set<NotificationEvent>(["picksReady"]));
  return json({ ok: result.failed === 0, ...result }, result.failed ? 502 : 200, env.CORS_ORIGIN);
};

const listNotificationSubscribers = async (payload: JsonObject, env: Env): Promise<Response> => {
  if (!env.EMAIL_RELAY_SECRET?.trim() || cleanText(payload.secret, 200) !== env.EMAIL_RELAY_SECRET.trim()) {
    return json({ ok: false, error: "Unauthorized." }, 401, env.CORS_ORIGIN);
  }
  const subscriptions = await env.DB.prepare(
    `SELECT player_name, destination, status
     FROM notification_subscriptions
     WHERE channel = 'email' AND status IN ('active', 'pending')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, player_name COLLATE NOCASE, destination COLLATE NOCASE`,
  ).all();
  return json({
    ok: true,
    subscribers: subscriptions.results.map((subscription) => ({
      email: String(subscription.destination || ""),
      playerName: String(subscription.player_name || "") === "FBP pool" ? "" : String(subscription.player_name || ""),
      status: String(subscription.status || ""),
    })),
  }, 200, env.CORS_ORIGIN);
};

const handleAnalytics = async (payload: JsonObject, env: Env): Promise<Response> => {
  const event = cleanText(payload.event, 30);
  const allowedEvents = new Set(["page_view", "picks_started", "submission"]);
  if (!allowedEvents.has(event)) return json({ ok: false, error: "Unknown analytics event." }, 400, env.CORS_ORIGIN);
  const browserId = cleanText(payload.browserId, 64).replace(/[^a-zA-Z0-9-]/g, "");
  const sessionId = cleanText(payload.sessionId, 64).replace(/[^a-zA-Z0-9-]/g, "");
  const view = cleanText(payload.view, 40);
  if (!browserId || !sessionId || !/^[a-z0-9-]{1,40}$/.test(view)) {
    return json({ ok: false, error: "Invalid analytics identifiers." }, 400, env.CORS_ORIGIN);
  }
  const context = {
    referrerDomain: cleanText(payload.referrerDomain, 100),
    device: cleanText(payload.device, 20),
    viewport: cleanText(payload.viewport, 20),
    language: cleanText(payload.language, 20),
    timeZone: cleanText(payload.timeZone, 60),
  };
  await env.DB
    .prepare(
      "INSERT INTO analytics_events (browser_id, session_id, event, view_name, context_json) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(browserId, sessionId, event, view, JSON.stringify(context))
    .run();
  return json({ ok: true }, 200, env.CORS_ORIGIN);
};

const submitCard = async (payload: JsonObject, env: Env): Promise<Response> => {
  if (env.OPERATIONAL_WRITES_ENABLED !== 'true') return json({ ok: false, error: 'Replacement submissions are disabled. Sheets currently owns the live submission path.' }, 409, env.CORS_ORIGIN);
  if (!Number.isSafeInteger(payload.expectedEpoch) || !Object.hasOwn(payload, 'expectedSubmissionId')) return json({ ok: false, error: 'Reload and check the current entry before submitting.' }, 409, env.CORS_ORIGIN);
  const adminEmail = String(env.ADMIN_SUBMISSION_EMAIL || '').trim().toLowerCase();
  const cardPayload = adminEmail && payload.mode !== 'test'
    ? { ...payload, confirmationEmailConsent: true, confirmationEmail: adminEmail }
    : payload;
  const result = await submitOperationalCard(env.DB, cardPayload);
  const receipt = result as Record<string, unknown>;
  if (!receipt.replayed && payload.mode !== 'test') {
    const playerName = String((receipt.identity as JsonObject | undefined)?.submittedName || '');
    const submissionId = Number(result.submissionId);
    const submission = await env.DB.prepare(
      `SELECT weeks.id AS week_id, weeks.week, submissions.submitted_at, MIN(games.kickoff_at) AS first_kickoff
       FROM submissions
       JOIN weeks ON weeks.id=submissions.week_id
       JOIN games ON games.week_id=weeks.id
       WHERE submissions.id=?
       GROUP BY weeks.id, weeks.week, submissions.submitted_at`,
    ).bind(submissionId).first<{ week_id: number; week: number; submitted_at: string; first_kickoff: string }>();
    const siteUrl = env.PUBLIC_SITE_URL || 'https://fbp26.github.io/fbp-stats/';
    if (payload.expectedSubmissionId != null) {
      await sendAdministratorPushOnce(env, 'adminPickReplacement', `admin-pick-replacement:${submissionId}`, `Picks replaced - Week ${submission?.week || payload.week}`, `${playerName} replaced their picks.`, `${siteUrl}#enter-picks`, submission?.week_id);
    }
    if (submission && Date.parse(submission.submitted_at) > Date.parse(submission.first_kickoff)) {
      await sendAdministratorPushOnce(env, 'adminLateSubmission', `admin-late-submission:${submissionId}`, `Late picks - Week ${submission.week}`, `${playerName} submitted picks after kickoff.`, `${siteUrl}#enter-picks`, submission.week_id);
    }
    const submissions = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM submissions JOIN players ON players.id=submissions.player_id WHERE canonical_name=? COLLATE NOCASE",
    ).bind(playerName).first<{ count: number }>();
    if (Number(submissions?.count) === 1) {
      await sendAdministratorPushOnce(env, 'adminNewPlayer', `admin-new-player:${playerName.toLowerCase()}`, 'New player joined', `${playerName} submitted their first FBP picks.`, `${env.PUBLIC_SITE_URL || 'https://fbp26.github.io/fbp-stats/'}#week-one`);
    }
  }
  return json(result, 200, env.CORS_ORIGIN);
};

const saveSubmissionConfirmationDetails = async (payload: JsonObject, env: Env): Promise<Response> => {
  const operationId = cleanText(payload.operationId, 100);
  const confirmationText = cleanText(payload.confirmationText, 15_000);
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(operationId) || !confirmationText) {
    return json({ ok: false, error: 'A submitted confirmation is required.' }, 400, env.CORS_ORIGIN);
  }
  const row = await env.DB.prepare("SELECT id,payload_json FROM submission_confirmation_outbox WHERE operation_id=? AND status IN ('queued','failed')")
    .bind(operationId).first<{ id: number; payload_json: string }>();
  if (!row) return json({ ok: false, error: 'The confirmation email is no longer available.' }, 404, env.CORS_ORIGIN);
  const stored = JSON.parse(row.payload_json) as JsonObject;
  await env.DB.prepare("UPDATE submission_confirmation_outbox SET payload_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','failed')")
    .bind(JSON.stringify({ ...stored, confirmationText }), row.id).run();
  return json({ ok: true }, 200, env.CORS_ORIGIN);
};

const correctSubmission = async (_payload: JsonObject, env: Env): Promise<Response> => {
  return json({ ok: false, error: 'Replacement-backend corrections require the private owner editor.' }, 403, env.CORS_ORIGIN);
};

const storeRaceSnapshot = async (payload: JsonObject, env: Env): Promise<Response> => {
  const control = await env.DB.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first<{ owner: string; epoch: number }>();
  if (control?.owner !== 'SHEETS') return json({ ok: false, error: 'Legacy browser race writes are disabled under D1 ownership.' }, 403, env.CORS_ORIGIN);
  const season = Number(payload.season);
  const weekNumber = Number(payload.week);
  if (!Number.isInteger(season) || !Number.isInteger(weekNumber)) {
    return json({ ok: false, error: "Season and week must be integers." }, 400, env.CORS_ORIGIN);
  }
  const week = await findWeek(env.DB, season, weekNumber, "REGULAR_SEASON");
  if (!week || week.status === "finalized") {
    return json({ ok: false, error: "The active regular-season week could not be found." }, 409, env.CORS_ORIGIN);
  }
  const games = await getWeekConfig(env.DB, Number(week.id));
  const cards = await loadPlayerCards(env.DB, Number(week.id));
  const scoringGames: ScoringGame[] = games.map((game) => ({
    favorite: String(game.favorite),
    underdog: String(game.underdog),
    spread: Number(game.spread),
    status: String(game.state || "PREGAME") as ScoringGame["status"],
    favoriteScore: game.favoriteScore === null ? null : Number(game.favoriteScore),
    underdogScore: game.underdogScore === null ? null : Number(game.underdogScore),
  }));
  const scoredPlayers = scoreWeekWithoutProbabilities(
    cards,
    scoringGames,
    week.tiebreak_actual === null ? null : Number(week.tiebreak_actual),
  );
  const submittedPlayers = validateRaceSnapshotPlayers(payload.players, scoredPlayers.map((player) => player.name));
  const scoreByName = new Map(scoredPlayers.map((player) => [player.name, player]));
  const gameState = games.map((game) => ({
    gameId: game.gameId,
    away: game.away || game.awayTeam,
    home: game.home || game.homeTeam,
    awayScore: game.awayScore ?? "",
    homeScore: game.homeScore ?? "",
    status: game.status || game.state,
    period: game.period || "",
    clock: game.clock || "",
    possession: game.possession || "",
  }));
  const gameStateJson = JSON.stringify(gameState);
  const latest = await env.DB
    .prepare(
      `SELECT captured_at, player_name, win_probability, paths, game_state_json
       FROM race_snapshots
       WHERE week_id = ? AND captured_at = (
         SELECT MAX(captured_at) FROM race_snapshots WHERE week_id = ?
       )
       ORDER BY player_name`,
    )
    .bind(week.id, week.id)
    .all();
  const latestByName = new Map(latest.results.map((row) => [String(row.player_name), row]));
  const unchanged = latest.results.length === submittedPlayers.length
    && latest.results.every((row) => String(row.game_state_json) === gameStateJson)
    && submittedPlayers.every((player) => {
      const prior = latestByName.get(player.name);
      return prior && Number(prior.win_probability) === player.winProbability
        && Number(prior.paths) === player.pathsToVictory;
    });
  if (unchanged) {
    return json({ ok: true, stored: false, capturedAt: String(latest.results[0].captured_at) }, 200, env.CORS_ORIGIN);
  }
  const capturedAt = new Date().toISOString();
  await env.DB.batch(submittedPlayers.map((player) => {
    const scored = scoreByName.get(player.name);
    return env.DB.prepare(
      `INSERT INTO race_snapshots
       (week_id, captured_at, player_name, win_probability, paths, win_pct, game_state_json)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM admin_control WHERE owner='SHEETS' AND epoch=?)`,
    ).bind(week.id, capturedAt, player.name, player.winProbability, player.pathsToVictory,
      scored?.winPercent || 0, gameStateJson, control.epoch);
  }));
  return json({ ok: true, stored: true, capturedAt }, 201, env.CORS_ORIGIN);
};

const handlePost = async (request: Request, env: Env): Promise<Response> => {
  const payload = await parsePayload(request);
  const action = cleanText(payload.action, 50);
  if (action === "notification-subscribers") return listNotificationSubscribers(payload, env);
  if (action === "release-picks-ready") return releasePicksReady(payload, env);
  if (action === "send-administrator-push") return sendAdministratorPushEvent(payload, env);
  if (action === "send-push-test") return sendPushTest(request, payload, env);
  if (action === "log-visit") return handleAnalytics(payload, env);
  if (action === "subscribe-push") return savePushDevice(payload, env);
  if (action === "link-push-player") return linkPushDevicePlayer(payload, env);
  if (action === "disable-push") return disablePushDevice(payload, env);
  if (action === "subscribe-notifications") return subscribeNotifications(request, payload, env);
  if (action === "update-notifications") return updateNotificationPreferences(payload, env);
  if (action === "correct-submission-name") return correctSubmission(payload, env);
  if (action === "submission-confirmation-details") return saveSubmissionConfirmationDetails(payload, env);
  if (action === "race-snapshot") return storeRaceSnapshot(payload, env);
  if (action === "assess-player-identity") {
    const submittedName = cleanText(payload.name, 100).replace(/\s+/g, " ");
    const player = submittedName
      ? await env.DB.prepare("SELECT canonical_name FROM players WHERE canonical_name = ? COLLATE NOCASE").bind(submittedName).first<{ canonical_name: string }>()
      : null;
    return json({
      ok: true,
      identity: {
        status: player ? 'known' : 'new',
        submittedName: player?.canonical_name || submittedName,
        canonicalizedFrom: player && player.canonical_name !== submittedName ? submittedName : "",
        knownPlayer: Boolean(player),
      },
    }, 200, env.CORS_ORIGIN);
  }
  if (action === 'private-ledger-transaction') return privateLedgerTransaction(request, env, payload);
  if (!action) return submitCard(payload, env);
  return json({ ok: false, error: "Unknown action." }, 400, env.CORS_ORIGIN);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    if (request.method !== "GET" && isLoopbackOrigin(origin)) {
      return json({ ok: false, error: "Local previews are read-only." }, 403, env.CORS_ORIGIN);
    }
    if (request.method === "OPTIONS") return json({ ok: true }, 200, env.CORS_ORIGIN);
    const requestEnv = { ...env, CORS_ORIGIN: requestCorsOrigin(request, env.CORS_ORIGIN) };
    try {
      if (request.method === "GET") return await handleGet(request, requestEnv);
      if (request.method === "POST") return await handlePost(request, requestEnv);
      return json({ ok: false, error: "Method not allowed." }, 405, requestEnv.CORS_ORIGIN);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error.";
      return json({ ok: false, error: message }, error instanceof SubmissionError ? error.status : 400, requestEnv.CORS_ORIGIN);
    }
  },
  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(refreshPublicReadSnapshots(env.DB, env.PICKS_SOURCE_URL, fetch, env.CANDIDATE_LIFECYCLE_ENABLED === 'true').catch(error => {
      console.error("Public read snapshot refresh failed:", error instanceof Error ? error.message : "Unexpected error");
    }));
    const weekBeforeRefresh = await activeWeek(env.DB);
    if (new Date(controller.scheduledTime).getUTCMinutes() % 5 === 0) await refreshActiveGameStates(env.DB);
    let refreshedWeek = weekBeforeRefresh
      ? await findWeek(env.DB, Number(weekBeforeRefresh.season), Number(weekBeforeRefresh.week), String(weekBeforeRefresh.phase))
      : null;
    if (refreshedWeek) await recordScheduledRaceSnapshot(env.DB, refreshedWeek);
    const lease = Date.now() + 180000;
    const locked = await env.DB.prepare("INSERT INTO notification_locks (name, expires_at) VALUES ('dispatch', ?) ON CONFLICT (name) DO UPDATE SET expires_at = excluded.expires_at WHERE notification_locks.expires_at < ?").bind(lease, Date.now()).run();
    if (!locked.meta.changes) return;
    try {
    if (!refreshedWeek || !weekBeforeRefresh) return;
    if (refreshedWeek?.status === "finalizing") await finalizeWeek(env.DB, refreshedWeek);
    refreshedWeek = await findWeek(env.DB, Number(weekBeforeRefresh.season), Number(weekBeforeRefresh.week), String(weekBeforeRefresh.phase));
    if (refreshedWeek) await awardFinalizedRegularWeek(env.DB, refreshedWeek);
  if (refreshedWeek?.phase === 'REGULAR_SEASON') await dispatchPushNotifications(env, refreshedWeek);
    if (refreshedWeek?.phase === 'REGULAR_SEASON') await dispatchAdministratorMissingPicksAlert(env, refreshedWeek);
    if (refreshedWeek?.phase === 'REGULAR_SEASON') await dispatchWeekNotifications(env, refreshedWeek);
    await dispatchSubmissionConfirmationOutbox(env.DB, (to, subject, body) => sendRelayEmail(env, to, subject, body));
    } finally {
      await env.DB.prepare("DELETE FROM notification_locks WHERE name = 'dispatch' AND expires_at = ?").bind(lease).run();
    }
  },
} satisfies ExportedHandler<Env>;
