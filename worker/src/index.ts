import { compareStandings, scoreWeekWithoutProbabilities, type PlayerCard, type ScoringGame } from "./scoring";
import { espnEventId, fetchEspnGame, isRefreshWindow, parseEspnGame, type StoredGame } from "./espn";
import { buildRaceGameState, validateRaceSnapshotPlayers } from "./race";
import { leaderPushSummary, maskNotificationDestination, normalizeNotificationDestination, notificationEvents, notificationPreferenceColumns, parseNotificationPreferences, picksDueReminderCheckpoints, picksDueReminderIsEligible, scheduledNotificationEvents, seasonRankMovementSummary, type LeaderPushScoreChange, type NotificationChannel, type NotificationEvent, type SeasonStanding } from "./notifications";
import { sendWebPush, type PushSubscriptionRecord } from "./web-push";

interface Env {
  DB: D1Database;
  CORS_ORIGIN: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_RELAY_URL?: string;
  EMAIL_RELAY_SECRET?: string;
  PUBLIC_API_URL?: string;
  PUBLIC_SITE_URL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  ADMIN_PUSH_PLAYER?: string;
  ADMIN_PUSH_TEST_SECRET?: string;
}

type JsonObject = Record<string, unknown>;

const json = (body: JsonObject, status = 200, origin = "*"): Response =>
  Response.json(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Cache-Control": "no-store",
    },
  });

const html = (body: string, status = 200): Response => new Response(body, {
  status,
  headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" },
});

const notificationPage = (title: string, body: string, status = 200): Response => html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#0d1117;color:#e8eef5;font:16px/1.55 Arial,sans-serif}main{width:min(560px,calc(100% - 32px));margin:48px auto;padding:28px;border:1px solid #2a3744;border-radius:6px;background:#151c24;box-sizing:border-box}h1{margin:0 0 10px;color:#ffcf40;font-size:26px;letter-spacing:0}p{margin:8px 0 18px}.alert-list{margin:10px 0 24px;padding-left:22px}.alert-list li{margin:5px 0}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.button{display:inline-block;padding:10px 16px;border:1px solid #ffcf40;border-radius:5px;background:#ffcf40;color:#111;text-decoration:none;font-weight:bold}.button.secondary{background:transparent;color:#e8eef5;border-color:#536273}@media(max-width:480px){main{margin:20px auto;padding:22px}.actions{display:grid}.button{text-align:center}}</style></head><body><main>${body}</main></body></html>`, status);

type VisitorEventRow = {
  browser_id: string;
  session_id: string;
  event: string;
  view_name: string;
  occurred_at: string;
  context_json: string;
  country: string | null;
  region: string | null;
  region_code: string | null;
  continent: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
};

const visitorGeographyReport = async (db: D1Database): Promise<JsonObject> => {
  const result = await db.prepare(
    `SELECT browser_id, session_id, event, view_name, occurred_at, context_json,
            country, region, region_code, continent, city, latitude, longitude
     FROM analytics_events
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY occurred_at DESC
     LIMIT 5000`,
  ).all<VisitorEventRow>();
  const rows = result.results;
  const locations = new Map<string, JsonObject>();
  const sessions = new Map<string, {
    startedAt: string;
    location: JsonObject;
    pages: JsonObject[];
  }>();

  for (const row of rows) {
    const latitude = Number(row.latitude), longitude = Number(row.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const country = row.country || "", region = row.region || "", city = row.city || "";
    const locationKey = [country, row.region_code || "", city, latitude.toFixed(3), longitude.toFixed(3)].join("|");
    const location = locations.get(locationKey) || {
      country,
      region,
      regionCode: row.region_code || "",
      continent: row.continent || "",
      city,
      latitude,
      longitude,
      views: 0,
      uniqueBrowsers: new Set<string>(),
      sessions: new Set<string>(),
      pickStarts: 0,
      submissions: 0,
      players: [],
    };
    if (row.event === "page_view") location.views = Number(location.views) + 1;
    if (row.event === "picks_started") location.pickStarts = Number(location.pickStarts) + 1;
    if (row.event === "submission") location.submissions = Number(location.submissions) + 1;
    (location.uniqueBrowsers as Set<string>).add(row.browser_id);
    (location.sessions as Set<string>).add(row.session_id);
    locations.set(locationKey, location);

    const session = sessions.get(row.session_id) || {
      startedAt: row.occurred_at,
      location: { country, region, city },
      pages: [],
    };
    if (row.occurred_at < session.startedAt) session.startedAt = row.occurred_at;
    if (row.event === "page_view") session.pages.unshift({
      view: row.view_name,
      enteredAt: row.occurred_at,
      durationSeconds: null,
    });
    if (row.event === "view_duration") {
      try {
        const context = JSON.parse(row.context_json) as { durationSeconds?: unknown };
        const page = session.pages.find((item) => item.view === row.view_name && item.durationSeconds == null);
        const duration = Number(context.durationSeconds);
        if (page && Number.isFinite(duration) && duration >= 0) page.durationSeconds = duration;
      } catch (error) {
        console.warn("Visitor duration context could not be parsed.", error);
      }
    }
    sessions.set(row.session_id, session);
  }

  return {
    updatedAt: new Date().toISOString(),
    privacy: "Session timelines contain page names, active time, and approximate Cloudflare network city/region/country. No IP addresses, browser IDs, or session IDs are published.",
    locations: [...locations.values()].map((location) => ({
      ...location,
      uniqueBrowsers: (location.uniqueBrowsers as Set<string>).size,
      sessions: (location.sessions as Set<string>).size,
    })),
    sessions: [...sessions.values()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((session, index) => ({
        sessionNumber: index + 1,
        startedAt: session.startedAt,
        location: session.location,
        pages: session.pages,
        activeSeconds: session.pages.reduce((total, page) => total + (Number(page.durationSeconds) || 0), 0),
      })),
  };
};

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
      "SELECT * FROM weeks WHERE phase = 'REGULAR_SEASON' AND status != 'finalized' ORDER BY season DESC, week DESC LIMIT 1",
    )
    .first();

const latestFinalizedRegularSeasonWeek = async (db: D1Database): Promise<Record<string, unknown> | null> =>
  db
    .prepare("SELECT * FROM weeks WHERE phase = 'REGULAR_SEASON' AND status = 'finalized' ORDER BY season DESC, week DESC LIMIT 1")
    .first();

const refreshActiveGameStates = async (db: D1Database): Promise<{ refreshed: number; skipped: string; scoreChanges: LeaderPushScoreChange[] }> => {
  const week = await activeWeek(db);
  if (!week) return { refreshed: 0, skipped: "no-active-week", scoreChanges: [] };
  const result = await db
    .prepare(
      `SELECT id, external_id, kickoff_at, favorite, underdog, home_team, away_team, metadata_json
       FROM games WHERE week_id = ? ORDER BY game_index`,
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
  if (!games.length) return { refreshed: 0, skipped: "no-games", scoreChanges: [] };
  if (!isRefreshWindow(games)) return { refreshed: 0, skipped: "outside-game-window", scoreChanges: [] };
  const eventIds = games.map(espnEventId);
  if (eventIds.some((eventId) => !eventId)) return { refreshed: 0, skipped: "missing-espn-event-id", scoreChanges: [] };
  const priorStates = await db.prepare("SELECT game_id, favorite_score, underdog_score FROM game_states WHERE game_id IN (SELECT id FROM games WHERE week_id = ?)")
    .bind(week.id).all<{ game_id: number; favorite_score: number | null; underdog_score: number | null }>();
  const priorStateByGameId = new Map(priorStates.results.map((state) => [state.game_id, state]));
  const payloads = await Promise.all(eventIds.map(fetchEspnGame));
  const updatedAt = new Date().toISOString();
  const updates = games.map((game, index) => parseEspnGame(payloads[index], game));
  const lastGameIndex = games.reduce((latest, game, index) => game.externalId > games[latest].externalId ? index : latest, 0);
  const statements: D1PreparedStatement[] = [];
  const scoreChanges: LeaderPushScoreChange[] = [];
  games.forEach((game, index) => {
    const update = updates[index];
    const prior = priorStateByGameId.get(game.id);
    const favoritePoints = Number(update.favoriteScore) - Number(prior?.favorite_score ?? 0);
    const underdogPoints = Number(update.underdogScore) - Number(prior?.underdog_score ?? 0);
    if (Number.isFinite(favoritePoints) && favoritePoints > 0 && update.favoriteScore !== null && update.underdogScore !== null) {
      scoreChanges.push({ team: game.favorite, points: favoritePoints, opposingTeam: game.underdog, teamScore: update.favoriteScore, opposingScore: update.underdogScore, spread: Number(game.metadata.spread ?? 0) });
    }
    if (Number.isFinite(underdogPoints) && underdogPoints > 0 && update.favoriteScore !== null && update.underdogScore !== null) {
      scoreChanges.push({ team: game.underdog, points: underdogPoints, opposingTeam: game.favorite, teamScore: update.underdogScore, opposingScore: update.favoriteScore, spread: -Number(game.metadata.spread ?? 0) });
    }
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (game_id) DO UPDATE SET state = excluded.state,
           favorite_score = excluded.favorite_score, underdog_score = excluded.underdog_score,
           period = excluded.period, clock = excluded.clock,
           net_passing_yards = excluded.net_passing_yards,
           source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at`,
      ).bind(game.id, update.state, update.favoriteScore, update.underdogScore, update.period, update.clock,
        index === lastGameIndex ? update.combinedNetPassingYards : null, updatedAt, updatedAt),
      db.prepare("UPDATE games SET metadata_json = ? WHERE id = ?").bind(JSON.stringify(metadata), game.id),
    );
  });
  const finalTiebreaker = updates[lastGameIndex].state === "FINAL" ? updates[lastGameIndex].combinedNetPassingYards : null;
  const weekStatus = updates.every((update) => update.state === "FINAL") ? "finalizing"
    : updates.some((update) => update.state === "LIVE" || update.state === "FINAL") ? "live" : "staged";
  statements.push(db.prepare("UPDATE weeks SET status = ?, tiebreak_actual = ? WHERE id = ?")
    .bind(weekStatus, finalTiebreaker, week.id));
  await db.batch(statements);
  return { refreshed: games.length, skipped: "", scoreChanges };
};

const refreshCurrentWeekIfStale = async (db: D1Database): Promise<void> => {
  await refreshActiveGameStates(db);
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
      `SELECT s.id, p.canonical_name, s.week_name, s.best_bet_game_index,
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
      bestBet: cardPicks[Number(row.best_bet_game_index)],
      tiebreaker: Number(row.tiebreaker),
    };
  });
};

const loadArchiveSubmissions = async (db: D1Database, weekId: number, gameCount: number): Promise<JsonObject[]> => {
  const submissions = await db
    .prepare(
      `SELECT s.id, p.canonical_name, s.week_name, s.best_bet_game_index,
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
      bestBet: submissionPicks[Number(row.best_bet_game_index)],
      tiebreaker: Number(row.tiebreaker),
      source: row.source,
    };
  });
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const finalizeWeek = async (env: Env, week: Record<string, unknown>): Promise<boolean> => {
  const db = env.DB;
  if (String(week.status) !== "finalizing" || week.tiebreak_actual === null) return false;
  const weekId = Number(week.id);
  const games = await getWeekConfig(db, weekId);
  if (!games.length || games.some((game) => game.state !== "FINAL")) return false;
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
    actualTiebreaker: Number(week.tiebreak_actual),
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
    })),
  };
  const payloadJson = JSON.stringify(payload);
  await db.batch([
    db.prepare(
      `INSERT INTO completed_week_archives (week_id, payload_json, checksum, finalized_at)
       VALUES (?, ?, ?, ?) ON CONFLICT (week_id) DO NOTHING`,
    ).bind(weekId, payloadJson, await sha256(payloadJson), finalizedAt),
    db.prepare("UPDATE weeks SET status = 'finalized', finalized_at = ? WHERE id = ? AND status = 'finalizing'")
      .bind(finalizedAt, weekId),
  ]);
  const cards = await loadPlayerCards(db, weekId);
  const finalGames = games.map((game) => ({
    favorite: String(game.favorite), underdog: String(game.underdog), spread: Number(game.spread),
    status: String(game.state) as ScoringGame["status"],
    favoriteScore: game.favoriteScore === null ? null : Number(game.favoriteScore),
    underdogScore: game.underdogScore === null ? null : Number(game.underdogScore),
  }));
  const winner = scoreWeekWithoutProbabilities(cards, finalGames, Number(week.tiebreak_actual)).sort(compareStandings)[0];
  const winnerSummary = winner
    ? `Winner: ${winner.name} (${winner.wins}-${winner.losses})\nTiebreaker: ${winner.tiebreaker} (actual: ${week.tiebreak_actual}; difference: ${winner.tiebreakDifference})`
    : "Winner could not be calculated from the finalized cards.";
  await sendOwnerOperationalEmail(env, `FBP Week ${weekNumber} finalized`, [
    `${season}-${season + 1} Week ${weekNumber} is finalized in D1.`, "", winnerSummary, "",
    `${submissions.length} active submission${submissions.length === 1 ? "" : "s"} were archived.`, "",
    "Payout reconciliation remains manual; this deployment did not change financial balances.", "",
    `Open FBP: ${env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/"}`,
  ].join("\n"));
  return true;
};

const buildCurrentWeek = async (
  db: D1Database,
  week: Record<string, unknown>,
): Promise<JsonObject> => {
  const games = await getWeekConfig(db, Number(week.id));
  const cards = await loadPlayerCards(db, Number(week.id));
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
  const liveTiebreaker = actualTiebreaker ?? (
    games.length && games.at(-1)?.netPassingYards !== null && games.at(-1)?.netPassingYards !== undefined
      ? Number(games.at(-1)?.netPassingYards)
      : null
  );
  return {
    ok: true,
    season: Number(week.season),
    seasonLabel: `${week.season}-${Number(week.season) + 1}`,
    week: Number(week.week),
    updatedAt: new Date().toISOString(),
    favorites: games.map((game) => game.favorite),
    favoriteScores: games.map((game) => game.favoriteScore),
    spreads: games.map((game) => game.spread),
    underdogScores: games.map((game) => game.underdogScore),
    underdogs: games.map((game) => game.underdog),
    actualTiebreaker: liveTiebreaker ?? "",
    tiebreakStatus: actualTiebreaker === null ? "live" : "final",
    probabilitySource: "client",
    games,
    players,
    raceSnapshots: [],
  };
};

const handleGet = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "current-week";
  if (action === "analytics-status") return json({ ok: true, analytics: true }, 200, env.CORS_ORIGIN);
  if (action === "visitor-geography") {
    try {
      return json(await visitorGeographyReport(env.DB), 200, env.CORS_ORIGIN);
    } catch (error) {
      console.error("Visitor geography report failed.", error);
      return json({ ok: false, error: "Visitor geography is temporarily unavailable." }, 502, env.CORS_ORIGIN);
    }
  }
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
    channels: { email: directEmailConfigured(env) || relayEmailConfigured(env), push: pushConfigured(env), sms: false },
    vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
  }, 200, env.CORS_ORIGIN);
  if (action === "backend-status") {
    const week = await activeWeek(env.DB);
    return json({ ok: true, owner: "D1", epoch: 1, available: true, writesEnabled: true, season: Number(week?.season) || 2026, week: Number(week?.week) || 0, staged: Boolean(week) }, 200, env.CORS_ORIGIN);
  }
  if (action === "review-week-setup") return reviewWeekSetupCandidate(url.searchParams.get("token") || "", env);

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
    const [configuredGames, pickRows, currentField] = await Promise.all([
      getWeekConfig(env.DB, Number(week.id)),
      env.DB.prepare(
        `SELECT g.game_index, sp.picked_team, COUNT(*) AS picks
         FROM submission_picks sp
         JOIN submissions s ON s.id = sp.submission_id
         JOIN games g ON g.id = sp.game_id
         WHERE s.week_id = ? AND s.superseded_at IS NULL
         GROUP BY g.game_index, sp.picked_team`,
      ).bind(week.id).all<{ game_index: number; picked_team: string; picks: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS count FROM submissions WHERE week_id = ? AND superseded_at IS NULL")
        .bind(week.id).first<{ count: number }>(),
    ]);
    const pickCountsByGame = new Map<number, Record<string, number>>();
    for (const row of pickRows.results) {
      const counts = pickCountsByGame.get(Number(row.game_index)) || {};
      counts[String(row.picked_team).toUpperCase()] = Number(row.picks);
      pickCountsByGame.set(Number(row.game_index), counts);
    }
    const pickCountTotal = Number(currentField?.count);
    const games = (await enrichActiveSlateGames(configuredGames, Number(week.season), Number(week.week))).map((game) => ({
      ...game,
      pickCountTotal,
      pickCounts: pickCountsByGame.get(Number(game.gameIndex)) || {},
    }));
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

  if (action === "season-status") {
    const week = await activeWeek(env.DB);
    if (!week) return json({ ok: false, error: "No regular-season week is staged." }, 404, env.CORS_ORIGIN);
    const [playedThisSeason, submittedCurrentWeek] = await Promise.all([
      env.DB.prepare(
        `SELECT DISTINCT p.canonical_name AS name
         FROM submissions s
         JOIN players p ON p.id = s.player_id
         JOIN weeks w ON w.id = s.week_id
         WHERE w.season = ? AND w.phase = 'REGULAR_SEASON' AND s.superseded_at IS NULL
         ORDER BY p.canonical_name COLLATE NOCASE`,
      ).bind(week.season).all<{ name: string }>(),
      env.DB.prepare(
        `SELECT DISTINCT p.canonical_name AS name
         FROM submissions s
         JOIN players p ON p.id = s.player_id
         WHERE s.week_id = ? AND s.superseded_at IS NULL
         ORDER BY p.canonical_name COLLATE NOCASE`,
      ).bind(week.id).all<{ name: string }>(),
    ]);
    const submittedNames = submittedCurrentWeek.results.map((player) => player.name);
    const submitted = new Set(submittedNames.map((name) => name.toLocaleLowerCase()));
    return json({
      ok: true,
      season: Number(week.season),
      week: Number(week.week),
      playedThisSeason: playedThisSeason.results.map((player) => player.name),
      submittedCurrentWeek: submittedNames,
      notYetSubmittedCurrentWeek: playedThisSeason.results
        .map((player) => player.name)
        .filter((name) => !submitted.has(name.toLocaleLowerCase())),
    }, 200, env.CORS_ORIGIN);
  }

  if (action === "current-week" || action === "week-one") {
    await refreshCurrentWeekIfStale(env.DB);
    const week = await activeWeek(env.DB);
    if (!week) return json({ ok: false, error: "No regular-season week is staged." }, 404, env.CORS_ORIGIN);
    const body = await buildCurrentWeek(env.DB, week);
    body.games = await enrichActiveSlateGames(
      Array.isArray(body.games) ? body.games as JsonObject[] : [],
      Number(week.season),
      Number(week.week),
    );
    return json(body, 200, env.CORS_ORIGIN);
  }

  const season = requiredInteger(url.searchParams.get("season"), 2026);
  const weekNumber = requiredInteger(url.searchParams.get("week"), 1);
  const phase = action === "preseason-test" ? "PRESEASON" : url.searchParams.get("phase") || "REGULAR_SEASON";
  const week = await findWeek(env.DB, season, weekNumber, phase);
  if (!week) return json({ ok: false, error: "Week not found." }, 404, env.CORS_ORIGIN);
  const weekId = Number(week.id);

  if (action === "existing-submission") {
    const name = cleanText(url.searchParams.get("name"), 100).replace(/\s+/g, " ");
    if (!name) return json({ ok: false, error: "A player name is required." }, 400, env.CORS_ORIGIN);
    const submission = await env.DB.prepare(
      `SELECT s.id, s.submitted_at, s.week_name, s.best_bet_game_index, s.tiebreaker, p.canonical_name
       FROM submissions s JOIN players p ON p.id = s.player_id
       WHERE s.week_id = ? AND p.canonical_name = ? COLLATE NOCASE AND s.superseded_at IS NULL
       ORDER BY s.submitted_at DESC LIMIT 1`,
    ).bind(weekId, name).first<{ id: number; submitted_at: string; week_name: string; best_bet_game_index: number; tiebreaker: number; canonical_name: string }>();
    if (!submission) return json({ ok: true, owner: "D1", epoch: 1, writesEnabled: true, submissionId: null, exists: false, player: null }, 200, env.CORS_ORIGIN);
    const picks = await env.DB.prepare(
      `SELECT sp.picked_team FROM submission_picks sp
       JOIN games g ON g.id = sp.game_id
       WHERE sp.submission_id = ? ORDER BY g.game_index`,
    ).bind(submission.id).all<{ picked_team: string }>();
    const player = {
      submittedAt: submission.submitted_at,
      name: submission.canonical_name,
      weekName: submission.week_name,
      picks: picks.results.map((pick) => pick.picked_team),
      bestBet: picks.results[Number(submission.best_bet_game_index)]?.picked_team || "",
      tiebreaker: Number(submission.tiebreaker),
    };
    return json({ ok: true, owner: "D1", epoch: 1, writesEnabled: true, submissionId: submission.id, exists: true, name: submission.canonical_name, submittedAt: submission.submitted_at, player }, 200, env.CORS_ORIGIN);
  }

  if (action === "week-config") {
    const games = await getWeekConfig(env.DB, weekId);
    const enrichedGames = url.searchParams.get("enrich") === "1"
      ? await enrichActiveSlateGames(games, season, weekNumber)
      : games;
    return json({ ok: true, season, week: weekNumber, phase, games: enrichedGames, enrichmentError: "" }, 200, env.CORS_ORIGIN);
  }

  if (action === "race-archive" || action === "current-week-race") {
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
          || String(left.name).localeCompare(String(right.name)))
        .slice(0, 12),
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

const directEmailConfigured = (env: Env): boolean => Boolean(env.RESEND_API_KEY?.trim() && env.EMAIL_FROM?.trim());

const relayEmailConfigured = (env: Env): boolean => Boolean(env.EMAIL_RELAY_URL?.trim() && env.EMAIL_RELAY_SECRET?.trim());

const pushConfigured = (env: Env): boolean => Boolean(env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim() && env.VAPID_SUBJECT?.trim());

const pushSubscriptionFromPayload = (value: unknown): PushSubscriptionRecord => {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const keys = source.keys && typeof source.keys === "object" ? source.keys as Record<string, unknown> : {};
  const endpoint = cleanText(source.endpoint, 2000), p256dh = cleanText(keys.p256dh, 200), auth = cleanText(keys.auth, 100);
  if (!/^https:\/\//.test(endpoint) || !/^[A-Za-z0-9_-]{80,}$/.test(p256dh) || !/^[A-Za-z0-9_-]{20,}$/.test(auth)) throw new Error("This browser did not provide a valid push subscription.");
  return { endpoint, p256dh, auth };
};

const savePushDevice = async (payload: JsonObject, env: Env): Promise<Response> => {
  if (!pushConfigured(env)) return json({ ok: false, error: "Push notifications are not configured yet." }, 503, env.CORS_ORIGIN);
  const subscription = pushSubscriptionFromPayload(payload.subscription), preferences = parseNotificationPreferences(payload.preferences);
  if (!notificationEvents.some((event) => preferences[event])) return json({ ok: false, error: "Choose at least one alert." }, 400, env.CORS_ORIGIN);
  const existing = await env.DB.prepare("SELECT device_token,status,picks_ready,picks_due,first_place,top_five,top_ten,lead_change,early_window,late_window,before_snf,before_mnf,weekly_result FROM push_devices WHERE endpoint=?")
    .bind(subscription.endpoint).first<Record<string, unknown>>();
  const deviceToken = String(existing?.device_token || randomToken()), values = notificationEvents.map((event) => preferences[event] ? 1 : 0);
  const preferencesChanged = existing?.status === "active" && notificationEvents.some((event, index) => Number(existing[notificationPreferenceColumns[event]]) !== values[index]);
  await env.DB.prepare(`INSERT INTO push_devices(endpoint,p256dh,auth,device_token,device_token_hash,status,picks_ready,picks_due,picks_due_minutes,first_place,top_five,top_ten,lead_change,early_window,late_window,before_snf,before_mnf,weekly_result,updated_at) VALUES(?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,status='active',picks_ready=excluded.picks_ready,picks_due=excluded.picks_due,picks_due_minutes=excluded.picks_due_minutes,first_place=excluded.first_place,top_five=excluded.top_five,top_ten=excluded.top_ten,lead_change=excluded.lead_change,early_window=excluded.early_window,late_window=excluded.late_window,before_snf=excluded.before_snf,before_mnf=excluded.before_mnf,weekly_result=excluded.weekly_result,unsubscribed_at=NULL,updated_at=CURRENT_TIMESTAMP`)
    .bind(subscription.endpoint, subscription.p256dh, subscription.auth, deviceToken, await sha256(deviceToken), values[0], values[1], Math.max(5, Math.min(300, Math.round(Number(payload.picksDueMinutes) || 60))), ...values.slice(2)).run();
  if (!existing || existing.status !== "active") {
    await sendAdministratorPushOnce(env, "adminPushEnabled", `admin-push-enabled:${deviceToken}`, "Push enabled", "A browser enabled FBP Push notifications.");
  } else if (preferencesChanged) {
    await sendAdministratorPushOnce(env, "adminPushPreferencesChanged", `admin-push-preferences:${deviceToken}:${new Date().toISOString()}`, "Push preferences changed", "A browser changed its FBP Push notification preferences.");
  }
  return json({ ok: true, deviceToken, status: "active" }, 200, env.CORS_ORIGIN);
};

const linkPushDevicePlayer = async (payload: JsonObject, env: Env): Promise<Response> => {
  const token = cleanText(payload.deviceToken, 64), playerName = cleanText(payload.playerName, 100).replace(/\s+/g, " ");
  if (!/^[a-f0-9]{64}$/.test(token)) return json({ ok: false, error: "Push notifications are not enabled on this device." }, 404, env.CORS_ORIGIN);
  const player = await env.DB.prepare("SELECT canonical_name FROM players WHERE canonical_name=? COLLATE NOCASE").bind(playerName).first<{ canonical_name: string }>();
  const device = await env.DB.prepare("SELECT id FROM push_devices WHERE device_token_hash=? AND status='active'").bind(await sha256(token)).first<{ id: number }>();
  if (!player) return json({ ok: false, error: "Choose an existing player name." }, 400, env.CORS_ORIGIN);
  if (!device) return json({ ok: false, error: "Push notifications are no longer active on this device." }, 404, env.CORS_ORIGIN);
  const linked = await env.DB.prepare("INSERT INTO push_device_players(device_id,player_name) VALUES(?,?) ON CONFLICT(device_id,player_name) DO NOTHING").bind(device.id, player.canonical_name).run();
  if (linked.meta.changes) await sendAdministratorPushOnce(env, "adminPushLinked", `admin-push-linked:${device.id}:${player.canonical_name.toLowerCase()}`, "Push linked", `${player.canonical_name} linked an active Push device.`);
  return json({ ok: true, playerName: player.canonical_name }, 200, env.CORS_ORIGIN);
};

const disablePushDevice = async (payload: JsonObject, env: Env): Promise<Response> => {
  const token = cleanText(payload.deviceToken, 64);
  if (!/^[a-f0-9]{64}$/.test(token)) return json({ ok: false, error: "Push notifications are not enabled on this device." }, 404, env.CORS_ORIGIN);
  const device = await env.DB.prepare("SELECT id FROM push_devices WHERE device_token_hash=? AND status='active'").bind(await sha256(token)).first<{ id: number }>();
  const players = device ? await env.DB.prepare("SELECT player_name FROM push_device_players WHERE device_id=? ORDER BY player_name").bind(device.id).all<{ player_name: string }>() : { results: [] };
  const disabled = await env.DB.prepare("UPDATE push_devices SET status='unsubscribed',unsubscribed_at=COALESCE(unsubscribed_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE device_token_hash=? AND status='active'").bind(await sha256(token)).run();
  if (disabled.meta.changes) await sendAdministratorPushOnce(env, "adminPushDisabled", `admin-push-disabled:${device?.id}:${new Date().toISOString()}`, "Push disabled", `${players.results.map((player) => player.player_name).join(", ") || "A browser"} disabled FBP Push notifications.`);
  return json({ ok: true }, 200, env.CORS_ORIGIN);
};

const dispatchPicksReadyPush = async (env: Env, week: Record<string, unknown>): Promise<NotificationDispatchResult> => {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (!pushConfigured(env)) return result;
  const devices = await env.DB.prepare("SELECT * FROM push_devices WHERE status='active' AND picks_ready=1").all<Record<string, unknown>>();
  for (const device of devices.results) {
    const key = `picksReady:${week.id}`;
    const queued = await env.DB.prepare("INSERT INTO push_deliveries(device_id,week_id,event_type,deduplication_key,status) VALUES(?,?,?,?, 'queued') ON CONFLICT(device_id,deduplication_key) DO NOTHING").bind(device.id, week.id, "picksReady", key).run();
    if (!queued.meta.changes) { result.skipped += 1; continue; }
    const sent = await sendWebPush({ endpoint: String(device.endpoint), p256dh: String(device.p256dh), auth: String(device.auth) }, {
      title: `Week ${week.week} picks are ready`, body: "The reviewed slate is open. Submit your picks before the first kickoff.", url: `${(env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/").replace(/\/$/, "")}#enter-picks`, tag: `fbp-${key}`,
    }, { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: env.VAPID_SUBJECT! });
    if (sent.expired) await env.DB.prepare("UPDATE push_devices SET status='unsubscribed',unsubscribed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(device.id).run();
    await env.DB.prepare("UPDATE push_deliveries SET status=?,sent_at=?,error_message=? WHERE device_id=? AND deduplication_key=?").bind(sent.ok ? "sent" : "failed", sent.ok ? new Date().toISOString() : null, sent.error || null, device.id, key).run();
    if (sent.ok) result.sent += 1;
    else result.failed += 1;
  }
  return result;
};

const sendAdministratorPushOnce = async (env: Env, eventType: string, deduplicationKey: string, title: string, body: string, weekId?: number): Promise<void> => {
  const administrator = cleanText(env.ADMIN_PUSH_PLAYER, 100).replace(/\s+/g, " ");
  if (!administrator || !pushConfigured(env)) return;
  const devices = await env.DB.prepare(
    `SELECT DISTINCT d.* FROM push_devices d
     JOIN push_device_players p ON p.device_id = d.id
     WHERE d.status = 'active' AND p.player_name = ? COLLATE NOCASE`,
  ).bind(administrator).all<Record<string, unknown>>();
  for (const device of devices.results) {
    const queued = await env.DB.prepare(
      "INSERT INTO push_deliveries(device_id,week_id,event_type,deduplication_key,status) VALUES(?,?,?,?, 'queued') ON CONFLICT(device_id,deduplication_key) DO NOTHING",
    ).bind(device.id, weekId || null, eventType, deduplicationKey).run();
    if (!queued.meta.changes) continue;
    const sent = await sendWebPush({ endpoint: String(device.endpoint), p256dh: String(device.p256dh), auth: String(device.auth) }, {
      title, body, url: `${(env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/").replace(/\/$/, "")}#enter-picks`, tag: `fbp-${deduplicationKey}`,
    }, { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: env.VAPID_SUBJECT! });
    if (sent.expired) await env.DB.prepare("UPDATE push_devices SET status='unsubscribed',unsubscribed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(device.id).run();
    await env.DB.prepare("UPDATE push_deliveries SET status=?,sent_at=?,error_message=? WHERE device_id=? AND deduplication_key=?")
      .bind(sent.ok ? "sent" : "failed", sent.ok ? new Date().toISOString() : null, sent.error || null, device.id, deduplicationKey).run();
  }
};

const missingPicksFromPriorWeek = async (
  db: D1Database,
  week: Record<string, unknown>,
): Promise<{ names: string[]; expectedCount: number }> => {
  const previousWeek = await db.prepare(
    `SELECT id FROM weeks
     WHERE season = ? AND phase = ? AND week < ? AND status = 'finalized'
     ORDER BY week DESC LIMIT 1`,
  ).bind(week.season, week.phase, week.week).first<{ id: number }>();
  if (!previousWeek) return { names: [], expectedCount: 0 };
  const expected = await db.prepare(
    `SELECT DISTINCT p.canonical_name AS name
     FROM submissions s
     JOIN players p ON p.id = s.player_id
     WHERE s.week_id = ? AND s.superseded_at IS NULL
     ORDER BY p.canonical_name COLLATE NOCASE`,
  ).bind(previousWeek.id).all<{ name: string }>();
  const submitted = await db.prepare(
    `SELECT DISTINCT p.canonical_name AS name
     FROM submissions s
     JOIN players p ON p.id = s.player_id
     WHERE s.week_id = ? AND s.superseded_at IS NULL`,
  ).bind(week.id).all<{ name: string }>();
  const expectedNames = [...new Set(expected.results.map((player) => player.name))];
  const submittedNames = new Set(submitted.results.map((player) => player.name.toLocaleLowerCase()));
  return {
    names: expectedNames.filter((name) => !submittedNames.has(name.toLocaleLowerCase())),
    expectedCount: expectedNames.length,
  };
};

const dispatchWeekPushNotifications = async (env: Env, week: Record<string, unknown>, scoreChanges: LeaderPushScoreChange[] = []): Promise<void> => {
  if (!pushConfigured(env)) return;
  const games = await getWeekConfig(env.DB, Number(week.id));
  const now = new Date();
  const events = new Set(scheduledNotificationEvents(now, games, String(week.status)));
  const picksDueCheckpoints = picksDueReminderCheckpoints(now, games, String(week.status));
  const missingPicks = picksDueCheckpoints.length
    ? await missingPicksFromPriorWeek(env.DB, week)
    : { names: [], expectedCount: 0 };
  const current = await buildCurrentWeek(env.DB, week);
  const players = (Array.isArray(current.players) ? current.players as JsonObject[] : []).sort((left, right) =>
    Number(right.total || 0) - Number(left.total || 0)
    || Number(left.tiebreakDifference ?? Number.POSITIVE_INFINITY) - Number(right.tiebreakDifference ?? Number.POSITIVE_INFINITY)
    || Number(left.losses || 0) - Number(right.losses || 0)
    || String(left.name).localeCompare(String(right.name)),
  );
  const hasStarted = games.some((game) => ["LIVE", "FINAL"].includes(String(game.state)));
  const previousObservation = await env.DB.prepare(
    "SELECT payload_json FROM notification_observations WHERE week_id = ?",
  ).bind(week.id).first<{ payload_json: string }>();
  let previousRanks: Record<string, number> = {};
  let previousLeaders: string[] = [];
  try {
    const previous = JSON.parse(previousObservation?.payload_json || "{}") as { ranks?: Record<string, number>; leaders?: string[] };
    previousRanks = previous.ranks || {};
    previousLeaders = previous.leaders || [];
  } catch (error) {
    console.warn("Saved push notification observation could not be parsed.", error);
  }
  const ranks = Object.fromEntries(players.map((player, index) => [
    String(player.name).toLowerCase(),
    Number(player.rank) || index + 1,
  ]));
  const leaders = players.filter((player, index) => (Number(player.rank) || index + 1) === 1).map((player) => String(player.name).toLowerCase());
  const leadChanged = previousLeaders.length > 0
    && (previousLeaders.length !== leaders.length || previousLeaders.some((leader) => !leaders.includes(leader)));
  if (hasStarted && players.length) events.add("firstPlace").add("topFive").add("topTen");
  if (leadChanged) events.add("leadChange");
  await env.DB.prepare(
    "INSERT INTO notification_observations (week_id, observed_at, payload_json) VALUES (?, ?, ?) ON CONFLICT (week_id) DO UPDATE SET observed_at = excluded.observed_at, payload_json = excluded.payload_json",
  ).bind(week.id, now.toISOString(), JSON.stringify({ ranks, leaders })).run();
  if (!events.size) return;
  const latestProbabilities = await env.DB.prepare(
    `SELECT player_name, win_probability FROM race_snapshots
     WHERE week_id = ? AND captured_at = (SELECT MAX(captured_at) FROM race_snapshots WHERE week_id = ?)`,
  ).bind(week.id, week.id).all<{ player_name: string; win_probability: number }>();
  const probabilityByPlayer = new Map(latestProbabilities.results.map((player) => [player.player_name.toLowerCase(), Number(player.win_probability)]));
  const seasonStandings = events.has("weeklyResult") ? await scoreArchivedSeason(env.DB, week) : null;
  const devices = await env.DB.prepare("SELECT * FROM push_devices WHERE status='active'").all<Record<string, unknown>>();
  for (const device of devices.results) {
    const linked = await env.DB.prepare("SELECT player_name FROM push_device_players WHERE device_id=?").bind(device.id).all<{ player_name: string }>();
    for (const event of events) {
      const column = notificationPreferenceColumns[event];
      if (!Number(device[column])) continue;
      const followed = linked.results.map((link) => players.find((player) => String(player.name).toLowerCase() === link.player_name.toLowerCase())).filter(Boolean);
      if (event === "picksDue" && followed.length) continue;
      if (event === "firstPlace" && !followed.some((player) => String(player?.name).toLowerCase() === String(players[0]?.name).toLowerCase())) continue;
      const enteredTopFive = followed.filter((player) => {
        const name = String(player?.name).toLowerCase();
        return Number(ranks[name]) <= 5 && Number(previousRanks[name]) > 5;
      });
      const enteredTopTen = followed.filter((player) => {
        const name = String(player?.name).toLowerCase();
        return Number(ranks[name]) <= 10 && Number(previousRanks[name]) > 10;
      });
      if (event === "topFive" && !enteredTopFive.length) continue;
      if (event === "topTen" && !enteredTopTen.length) continue;
      if (event === "leadChange" && !leadChanged) continue;
      const key = event === "firstPlace"
        ? `${event}:${week.id}:${String(players[0]?.name || "").toLowerCase()}`
        : event === "topFive" ? `${event}:${week.id}:${enteredTopFive.map((player) => String(player?.name).toLowerCase()).join(",")}`
        : event === "topTen" ? `${event}:${week.id}:${enteredTopTen.map((player) => String(player?.name).toLowerCase()).join(",")}`
        : event === "leadChange" ? `${event}:${week.id}:${leaders.join(",")}`
        : `${event}:${week.id}`;
      const queued = await env.DB.prepare("INSERT INTO push_deliveries(device_id,week_id,event_type,deduplication_key,status) VALUES(?,?,?,?, 'queued') ON CONFLICT(device_id,deduplication_key) DO NOTHING")
        .bind(device.id, week.id, event, key).run();
      if (!queued.meta.changes) continue;
      const followedName = linked.results[0]?.player_name || "";
      const body = event === "firstPlace"
        ? leaderPushSummary(
          { name: String(players[0]?.name || "The leader"), winProbability: probabilityByPlayer.get(String(players[0]?.name || "").toLowerCase()) ?? null },
          players[1] ? { name: String(players[1].name), winProbability: probabilityByPlayer.get(String(players[1].name).toLowerCase()) ?? null } : null,
          scoreChanges.at(-1) || null,
        )
        : event === "topFive"
        ? `${enteredTopFive.map((player) => String(player?.name)).join(" and ")} moved into the top 5.`
        : event === "topTen"
        ? `${enteredTopTen.map((player) => String(player?.name)).join(" and ")} moved into the top 10.`
        : event === "leadChange"
        ? `Pool lead change: ${players.filter((player, index) => (Number(player.rank) || index + 1) === 1).map((player) => String(player.name)).join(" and ")} moved into first place.`
        : event === "weeklyResult" && followedName
        ? weeklyResultSummary(players, followedName, seasonStandings)
        : event === "picksDue" ? "Your picks are not in yet. Open FBP before the first kickoff." : "Open FBP for the latest pool update.";
      const sent = await sendWebPush({ endpoint: String(device.endpoint), p256dh: String(device.p256dh), auth: String(device.auth) }, {
        title: `FBP Week ${week.week}: ${notificationEventLabels[event]}`,
        body,
        url: `${(env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/").replace(/\/$/, "")}#current-week`, tag: `fbp-${key}`,
      }, { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: env.VAPID_SUBJECT! });
      if (sent.expired) await env.DB.prepare("UPDATE push_devices SET status='unsubscribed',unsubscribed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(device.id).run();
      await env.DB.prepare("UPDATE push_deliveries SET status=?,sent_at=?,error_message=? WHERE device_id=? AND deduplication_key=?")
        .bind(sent.ok ? "sent" : "failed", sent.ok ? new Date().toISOString() : null, sent.error || null, device.id, key).run();
    }
    const administrator = cleanText(env.ADMIN_PUSH_PLAYER, 100).replace(/\s+/g, " ");
    const isAdministratorDevice = administrator
      && linked.results.some((player) => player.player_name.localeCompare(administrator, undefined, { sensitivity: "accent" }) === 0);
    if (!Number(device.picks_due) || !isAdministratorDevice || !missingPicks.names.length) continue;
    for (const minutesBeforeKickoff of picksDueCheckpoints) {
      const key = `picksDue:${week.id}:${minutesBeforeKickoff}`;
      const queued = await env.DB.prepare("INSERT INTO push_deliveries(device_id,week_id,event_type,deduplication_key,status) VALUES(?,?,?,?, 'queued') ON CONFLICT(device_id,deduplication_key) DO NOTHING")
        .bind(device.id, week.id, "picksDue", key).run();
      if (!queued.meta.changes) continue;
      const body = `${missingPicks.names.length} of ${missingPicks.expectedCount} expected entries are missing: ${missingPicks.names.join(", ")}.`;
      const sent = await sendWebPush({ endpoint: String(device.endpoint), p256dh: String(device.p256dh), auth: String(device.auth) }, {
        title: `FBP Week ${week.week}: ${missingPicks.names.length} missing picks (${minutesBeforeKickoff} min)`,
        body,
        url: `${(env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/").replace(/\/$/, "")}#enter-picks`,
        tag: `fbp-${key}`,
      }, { publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: env.VAPID_SUBJECT! });
      if (sent.expired) await env.DB.prepare("UPDATE push_devices SET status='unsubscribed',unsubscribed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(device.id).run();
      await env.DB.prepare("UPDATE push_deliveries SET status=?,sent_at=?,error_message=? WHERE device_id=? AND deduplication_key=?")
        .bind(sent.ok ? "sent" : "failed", sent.ok ? new Date().toISOString() : null, sent.error || null, device.id, key).run();
    }
  }
};

const sendResendEmail = async (env: Env, to: string, subject: string, body: string, htmlBody = ""): Promise<boolean> => {
  if (!directEmailConfigured(env)) return false;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY?.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM?.trim(),
        to: [to],
        subject,
        text: body,
        ...(htmlBody ? { html: htmlBody } : {}),
      }),
    });
    if (!response.ok) console.warn("Resend email failed", response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.warn("Resend email failed", error);
    return false;
  }
};

const sendEmail = async (env: Env, to: string, subject: string, body: string, htmlBody = ""): Promise<boolean> => {
  if (await sendResendEmail(env, to, subject, body, htmlBody)) return true;
  if (!env.EMAIL_RELAY_URL?.trim() || !env.EMAIL_RELAY_SECRET?.trim()) return false;
  try {
    const response = await fetch(env.EMAIL_RELAY_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ action: "send-notification-email", secret: env.EMAIL_RELAY_SECRET, to, subject, body, htmlBody }),
    });
    const result = await response.json().catch(() => null) as { ok?: boolean } | null;
    return response.ok && result?.ok === true;
  } catch (error) {
    console.warn("Email relay failed", error);
    return false;
  }
};

const preparePickSubmissionConfirmation = async (env: Env, details: JsonObject): Promise<string> => {
  if (!env.EMAIL_RELAY_URL?.trim() || !env.EMAIL_RELAY_SECRET?.trim()) return "";
  const response = await fetch(env.EMAIL_RELAY_URL.trim(), {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ action: "prepare-d1-pick-confirmation-email", secret: env.EMAIL_RELAY_SECRET, ...details }),
  });
  const result = await response.json().catch(() => null) as { ok?: boolean; confirmationEmailToken?: unknown } | null;
  return response.ok && result?.ok === true ? cleanText(result.confirmationEmailToken, 100) : "";
};

const relayPickConfirmationEmail = async (env: Env, payload: JsonObject): Promise<Response> => {
  if (!env.EMAIL_RELAY_URL?.trim()) {
    return json({ ok: false, error: "Pick confirmation email delivery is unavailable." }, 503, env.CORS_ORIGIN);
  }
  try {
    const response = await fetch(env.EMAIL_RELAY_URL.trim(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({
        action: "send-pick-confirmation-email",
        confirmationEmailToken: cleanText(payload.confirmationEmailToken, 100),
        confirmationText: cleanText(payload.confirmationText, 15_000),
        confirmationSections: payload.confirmationSections,
      }),
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "application/json; charset=UTF-8",
        "Access-Control-Allow-Origin": env.CORS_ORIGIN,
      },
    });
  } catch (error) {
    console.warn("Pick confirmation email relay failed", error);
    return json({ ok: false, error: "Pick confirmation email delivery failed." }, 502, env.CORS_ORIGIN);
  }
};

const sendOwnerOperationalEmail = async (env: Env, subject: string, body: string, htmlBody = ""): Promise<boolean> => {
  if (directEmailConfigured(env)) return sendEmail(env, "fbpool07@gmail.com", subject, body, htmlBody);
  const relayUrl = env.EMAIL_RELAY_URL?.trim();
  if (!relayUrl || !env.EMAIL_RELAY_SECRET?.trim()) return false;
  const response = await fetch(relayUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ action: "send-owner-operational-email", secret: env.EMAIL_RELAY_SECRET, subject, body, htmlBody }),
  });
  const result = await response.json().catch(() => null) as { ok?: boolean } | null;
  return response.ok && result?.ok === true;
};

const pickSubmissionOwnerEmail = (
  playerName: string,
  weekNumber: number,
  submittedAt: string,
  games: Array<{ favorite: string; spread: number; underdog: string }>,
  picks: string[],
  bestBet: string,
  tiebreaker: number,
  replaced: boolean,
): { subject: string; body: string; html: string } => {
  const heading = replaced ? "Picks replaced" : "Picks submitted";
  const rows = games.map((game, index) => {
    const pick = picks[index] || "";
    const line = `${index + 1}. ${game.favorite} ${game.spread} ${game.underdog} — ${pick}${pick === bestBet ? " (Best Bet)" : ""}`;
    return { line, game, pick };
  });
  const submitted = formatEasternDateTime(submittedAt);
  const body = [
    `${heading}: ${playerName}`,
    `Week ${weekNumber} · ${submitted}`,
    "",
    ...rows.map((row) => row.line),
    "",
    `Tiebreaker: ${tiebreaker}`,
  ].join("\n");
  const html = `<main style="max-width:620px;margin:0 auto;font-family:Arial,sans-serif;color:#17212b">
<h2 style="margin:0 0 12px">FBP Week ${weekNumber}: ${escapeHtml(heading)}</h2>
<p><strong>${escapeHtml(playerName)}</strong> ${replaced ? "updated" : "submitted"} picks on ${escapeHtml(submitted)}.</p>
<ol>${rows.map(({ game, pick }) => `<li><strong>${escapeHtml(game.favorite)} ${escapeHtml(game.spread)} ${escapeHtml(game.underdog)}</strong> — ${escapeHtml(pick)}${pick === bestBet ? ` <span style="color:#8a6400;font-weight:bold">(Best Bet)</span>` : ""}</li>`).join("")}</ol>
<p><strong>Tiebreaker:</strong> ${escapeHtml(tiebreaker)}</p>
</main>`;
  return { subject: `FBP Week ${weekNumber}: ${heading} — ${playerName}`, body, html };
};

const formatEasternDateTime = (iso: string): string => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
}).format(new Date(iso));

const weekSetupEmail = (week: number, games: YahooWeekGame[], reviewUrl: string, expiresAt: string, intro: string): { body: string; html: string } => {
  const lines = games.map((game, index) => `${index + 1}. ${game.favorite} ${game.spread} ${game.underdog}`).join("\n");
  const expiration = formatEasternDateTime(expiresAt);
  return {
    body: [intro, "", lines, "", "Review and approve the slate:", reviewUrl, "", `This approval link expires ${expiration}.`].join("\n"),
    html: `<main style="max-width:620px;margin:0 auto;font-family:Arial,sans-serif;color:#17212b"><h2 style="margin:0 0 12px">FBP Week ${week} setup is ready</h2><p>${escapeHtml(intro)}</p><ol>${games.map(game => `<li>${escapeHtml(game.favorite)} ${game.spread} ${escapeHtml(game.underdog)}</li>`).join("")}</ol><p style="margin:24px 0"><a href="${escapeHtml(reviewUrl)}" style="display:inline-block;padding:12px 18px;border-radius:6px;background:#1677ff;color:#fff;text-decoration:none;font-weight:bold">Review and approve Week ${week}</a></p><p style="color:#52606d">This approval link expires ${escapeHtml(expiration)}.</p></main>`,
  };
};

const syncFinalizedPayouts = async (env: Env): Promise<boolean> => {
  const relayUrl = env.EMAIL_RELAY_URL?.trim();
  if (!relayUrl || !env.EMAIL_RELAY_SECRET?.trim()) return false;
  try {
    const response = await fetch(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ action: "sync-finalized-payouts", secret: env.EMAIL_RELAY_SECRET }),
    });
    const result = await response.json().catch(() => null) as { ok?: boolean } | null;
    return response.ok && result?.ok === true;
  } catch (error) {
    console.warn("Finalized payout sync relay failed", error);
    return false;
  }
};

const syncPriorWeekPayoutsAfterSetup = async (env: Env, stagedWeek: Record<string, unknown>): Promise<boolean> => {
  const prior = await latestFinalizedRegularSeasonWeek(env.DB);
  if (!prior || Number(prior.season) !== Number(stagedWeek.season) || Number(prior.week) + 1 !== Number(stagedWeek.week)) return true;
  const synchronized = await env.DB.prepare(
    "SELECT 1 AS synchronized FROM payout_syncs WHERE season = ? AND week = ?",
  ).bind(prior.season, prior.week).first<{ synchronized: number }>();
  if (synchronized) return true;
  if (!await syncFinalizedPayouts(env)) return false;
  await env.DB.prepare(
    "INSERT INTO payout_syncs (season, week, synchronized_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT (season, week) DO NOTHING",
  ).bind(prior.season, prior.week).run();
  return true;
};

type YahooWeekGame = {
  gameId: string;
  kickoff: string;
  away: string;
  home: string;
  favorite: string;
  spread: number;
  underdog: string;
  url: string;
};

const fetchYahooWeekGames = async (season: number, week: number): Promise<YahooWeekGame[]> => {
  const scheduleUrl = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}&limit=100`;
  const yahooUrl = `https://sports.yahoo.com/nfl/scoreboard/?week=${week}&seasonPhase=REGULAR_SEASON`;
  const [scheduleResponse, yahooResponse] = await Promise.all([
    fetch(scheduleUrl, { cf: { cacheTtl: 300 } }),
    fetch(yahooUrl, { headers: { Accept: "text/html" }, cf: { cacheTtl: 300 } }),
  ]);
  if (!scheduleResponse.ok) throw new Error(`ESPN schedule request returned HTTP ${scheduleResponse.status}.`);
  if (!yahooResponse.ok) throw new Error(`Yahoo scoreboard request returned HTTP ${yahooResponse.status}.`);
  const scoreboard = await scheduleResponse.json() as { events?: { id?: string; date?: string; competitions?: { competitors?: { homeAway?: string; team?: { abbreviation?: string; displayName?: string } }[] }[] }[] };
  const yahooHtml = await yahooResponse.text();
  const yahooOdds: { gameId: string; matchup: string; favorite: string; spread: number }[] = [];
  const cardPattern = /gameId:nfl\.g\.(\d+);itc:0;slk:([^;]+);/g;
  for (const card of yahooHtml.matchAll(cardPattern)) {
    const odds = yahooHtml.slice(card.index ?? 0, (card.index ?? 0) + 12000).match(/\b([A-Z]{2,3}) ([+-]\d+(?:\.\d+)?)/);
    if (odds) yahooOdds.push({ gameId: card[1], matchup: card[2], favorite: normalizeNflAbbreviation(odds[1]), spread: Math.abs(Number(odds[2])) });
  }
  const games = (scoreboard.events || []).map((event) => {
    const competition = event.competitions?.[0] || {};
    const away = normalizeNflAbbreviation(competition.competitors?.find((team) => team.homeAway === "away")?.team?.abbreviation);
    const home = normalizeNflAbbreviation(competition.competitors?.find((team) => team.homeAway === "home")?.team?.abbreviation);
    const awayName = competition.competitors?.find((team) => team.homeAway === "away")?.team?.displayName || "";
    const homeName = competition.competitors?.find((team) => team.homeAway === "home")?.team?.displayName || "";
    const yahooCity = (name: string) => ({
      "Los Angeles Rams": "LA Rams",
      "New York Giants": "NY Giants",
      "New York Jets": "NY Jets",
    } as Record<string, string>)[name] || name.replace(/ (?:49ers|Bears|Bengals|Bills|Broncos|Browns|Buccaneers|Cardinals|Chargers|Chiefs|Colts|Commanders|Cowboys|Dolphins|Eagles|Falcons|Forty Niners|Giants|Jaguars|Jets|Lions|Packers|Panthers|Patriots|Raiders|Rams|Ravens|Saints|Seahawks|Steelers|Texans|Titans|Vikings)$/i, "").replace("Los Angeles", "LA").replace("New York", "NY");
    const yahooGame = yahooOdds.find((game) => game.matchup === `${yahooCity(awayName)} @ ${yahooCity(homeName)}`);
    const favoriteCode = yahooGame?.favorite || "";
    const underdogCode = favoriteCode === away ? home : away;
    return {
      gameId: `espn.${event.id || ""}`,
      kickoff: String(event.date || ""),
      away: away.toLowerCase(),
      home: home.toUpperCase(),
      favorite: favoriteCode === home ? home.toUpperCase() : favoriteCode.toLowerCase(),
      spread: yahooGame?.spread ?? Number.NaN,
      underdog: underdogCode === home ? home.toUpperCase() : underdogCode.toLowerCase(),
      url: yahooUrl,
    };
  }).filter((game) => game.gameId !== "espn." && game.kickoff && game.away && game.home && game.favorite && game.underdog && Number.isFinite(game.spread));
  if (games.length !== (scoreboard.events || []).length) {
    throw new Error(`Yahoo lines matched ${games.length} of ${(scoreboard.events || []).length} scheduled games.`);
  }
  return games
    .sort((left, right) => Date.parse(left.kickoff) - Date.parse(right.kickoff));
};

const normalizeNflAbbreviation = (value: unknown): string => ({ WSH: "WAS", JAC: "JAX", LA: "LAR" }[String(value || "").toUpperCase()] || String(value || "").toUpperCase());

const openMeteoWeatherLabel = (code: number): string => {
  if ([95, 96, 99].includes(code)) return "Thunderstorms";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain";
  if ([45, 48].includes(code)) return "Fog";
  if (code === 3) return "Overcast";
  if ([1, 2].includes(code)) return "Cloudy";
  if (code === 0) return "Clear";
  return "";
};

const fetchOpenMeteoForecast = async (
  city: string,
  country: string,
  kickoff: string,
): Promise<{ temperature: number | null; weather: string } | null> => {
  if (!city || !kickoff) return null;
  const countryCode = ({
    England: "GB",
    "United Kingdom": "GB",
    "United States": "US",
    USA: "US",
  } as Record<string, string>)[country] || (/^[A-Z]{2}$/.test(country) ? country : "");
  const geocode = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json${countryCode ? `&countryCode=${encodeURIComponent(countryCode)}` : ""}`,
    { cf: { cacheTtl: 86_400 } },
  );
  if (!geocode.ok) return null;
  const locations = await geocode.json() as { results?: { latitude?: number; longitude?: number }[] };
  const location = locations.results?.[0];
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const forecast = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=temperature_2m,precipitation_probability,wind_gusts_10m,weather_code&timezone=UTC&forecast_days=7`,
    { cf: { cacheTtl: 900 } },
  );
  if (!forecast.ok) return null;
  const hourly = (await forecast.json()) as {
    hourly?: { time?: string[]; temperature_2m?: number[]; precipitation_probability?: number[]; wind_gusts_10m?: number[]; weather_code?: number[] };
  };
  const kickoffTime = Date.parse(kickoff);
  if (!Number.isFinite(kickoffTime) || !hourly.hourly?.time?.length) return null;
  let closestIndex = -1;
  let closestDifference = Number.POSITIVE_INFINITY;
  for (const [index, time] of hourly.hourly.time.entries()) {
    const difference = Math.abs(Date.parse(`${time}Z`) - kickoffTime);
    if (difference < closestDifference) {
      closestDifference = difference;
      closestIndex = index;
    }
  }
  if (closestIndex < 0 || closestDifference > 90 * 60 * 1000) return null;
  const temperatureCelsius = Number(hourly.hourly.temperature_2m?.[closestIndex]);
  const precipitation = Number(hourly.hourly.precipitation_probability?.[closestIndex]);
  const gustKilometersPerHour = Number(hourly.hourly.wind_gusts_10m?.[closestIndex]);
  const condition = openMeteoWeatherLabel(Number(hourly.hourly.weather_code?.[closestIndex]));
  const details = [
    condition,
    Number.isFinite(precipitation) ? `${Math.round(precipitation)}% precip` : "",
    Number.isFinite(gustKilometersPerHour) ? `gusts ${Math.round(gustKilometersPerHour * 0.621371)} mph` : "",
  ].filter(Boolean).join("; ");
  return {
    temperature: Number.isFinite(temperatureCelsius) ? Math.round((temperatureCelsius * 9) / 5 + 32) : null,
    weather: details,
  };
};

const enrichActiveSlateGames = async (games: JsonObject[], season: number, week: number): Promise<JsonObject[]> => {
  const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}&limit=100`, { cf: { cacheTtl: 300 } });
  if (!response.ok) return games;
  const scoreboard = await response.json() as { events?: { id?: string; competitions?: { competitors?: { homeAway?: string; records?: { summary?: string }[]; team?: { abbreviation?: string; displayName?: string } }[]; venue?: { fullName?: string; indoor?: boolean; address?: { city?: string; state?: string } }; broadcasts?: { names?: string[] }[] }[] }[] };
  const events = new Map((scoreboard.events || []).map((event) => [String(event.id || ""), event]));
  const summaries = await Promise.all(games.map(async (game) => {
    const eventId = String(game.gameId || "").replace(/^espn\./, "");
    const competition = events.get(eventId)?.competitions?.[0];
    if (!eventId || competition?.venue?.indoor) return [eventId, null] as const;
    try {
      const summaryResponse = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${encodeURIComponent(eventId)}`, { cf: { cacheTtl: 900 } });
      if (!summaryResponse.ok) return [eventId, null] as const;
      const summary = await summaryResponse.json() as {
        gameInfo?: {
          weather?: { temperature?: number; gust?: number; precipitation?: number };
          venue?: { address?: { city?: string; country?: string } };
        };
      };
      const weather = summary.gameInfo?.weather;
      if (!weather) {
        return [eventId, await fetchOpenMeteoForecast(
          String(summary.gameInfo?.venue?.address?.city || ""),
          String(summary.gameInfo?.venue?.address?.country || ""),
          String(game.kickoff || ""),
        )] as const;
      }
      const details = [
        Number.isFinite(Number(weather.precipitation)) ? `${Number(weather.precipitation)}% precip` : "",
        Number.isFinite(Number(weather.gust)) ? `gusts ${Number(weather.gust)} mph` : "",
      ].filter(Boolean).join("; ");
      return [eventId, {
        temperature: Number.isFinite(Number(weather.temperature)) ? Number(weather.temperature) : null,
        weather: details,
      }] as const;
    } catch (error) {
      console.warn("ESPN forecast enrichment failed", eventId, error);
      return [eventId, null] as const;
    }
  }));
  const forecastByEventId = new Map(summaries);
  return games.map((game) => {
    const event = events.get(String(game.gameId || "").replace(/^espn\./, ""));
    const competition = event?.competitions?.[0];
    if (!competition) return game;
    const competitor = (homeAway: string) => competition.competitors?.find((entry) => entry.homeAway === homeAway);
    const awayEntry = competitor("away"), homeEntry = competitor("home");
    const away = awayEntry?.team, home = homeEntry?.team, venue = competition.venue;
    const normalizedFavorite = normalizeNflAbbreviation(game.favorite);
    const normalizedUnderdog = normalizeNflAbbreviation(game.underdog);
    return {
      ...game,
      favorite: String(game.favorite || "") === String(game.favorite || "").toUpperCase() ? normalizedFavorite : normalizedFavorite.toLowerCase(),
      underdog: String(game.underdog || "") === String(game.underdog || "").toUpperCase() ? normalizedUnderdog : normalizedUnderdog.toLowerCase(),
      away: normalizeNflAbbreviation(away?.abbreviation).toLowerCase() || game.away,
      home: normalizeNflAbbreviation(home?.abbreviation) || game.home,
      awayTeam: { abbreviation: normalizeNflAbbreviation(away?.abbreviation), name: away?.displayName || "", record: awayEntry?.records?.[0]?.summary || "" },
      homeTeam: { abbreviation: normalizeNflAbbreviation(home?.abbreviation), name: home?.displayName || "", record: homeEntry?.records?.[0]?.summary || "" },
      venueName: venue?.fullName || "",
      venueCity: venue?.address?.city || "",
      venueState: venue?.address?.state || "",
      indoor: Boolean(venue?.indoor),
      ...(forecastByEventId.get(String(game.gameId || "").replace(/^espn\./, "")) || {}),
      broadcast: competition.broadcasts?.flatMap((entry) => entry.names || []).join(", ") || "",
    };
  });
};

const createWeekSetupCandidate = async (env: Env): Promise<void> => {
  const active = await latestFinalizedRegularSeasonWeek(env.DB);
  if (!active || Number(active.week) >= 18) return;
  const season = Number(active.season), week = Number(active.week) + 1;
  const existingWeek = await findWeek(env.DB, season, week, "REGULAR_SEASON");
  if (existingWeek && String(existingWeek.status) !== "finalized") return;
  const games = await fetchYahooWeekGames(season, week);
  if (games.length < 10 || games.length > 16) return;
  const slateJson = JSON.stringify({ season, week, games });
  const slateHash = await sha256(slateJson);
  const existing = await env.DB.prepare(
    "SELECT id FROM week_setup_candidates WHERE season=? AND week=? AND phase='REGULAR_SEASON' AND status='pending' AND expires_at > CURRENT_TIMESTAMP",
  ).bind(season, week).first();
  if (existing) return;
  await env.DB.prepare("UPDATE week_setup_candidates SET status='superseded' WHERE season=? AND week=? AND phase='REGULAR_SEASON' AND status='pending'")
    .bind(season, week).run();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO week_setup_candidates(season,week,phase,slate_hash,slate_json,approval_token_hash,expires_at) VALUES (?,?,'REGULAR_SEASON',?,?,?,?)",
  ).bind(season, week, slateHash, slateJson, await sha256(token), expiresAt).run();
  const reviewUrl = `${env.PUBLIC_API_URL || "https://fbp-api.fbp-api-worker.workers.dev"}/?action=review-week-setup&token=${token}`;
  const email = weekSetupEmail(week, games, reviewUrl, expiresAt, `Yahoo has a valid favorite, point spread, and underdog for all ${games.length} games.`);
  await sendOwnerOperationalEmail(env, `FBP Week ${week} lines are ready for setup approval`, email.body, email.html);
  await sendAdministratorPushOnce(
    env,
    "adminWeekSetupReady",
    `admin-week-setup-ready:${season}:${week}:${slateHash}`,
    `FBP Week ${week} lines are ready`,
    "Review and approve the complete Yahoo slate to open picks.",
  );
};

const reviewWeekSetupCandidate = async (token: string, env: Env): Promise<Response> => {
  if (!/^[a-f0-9]{64}$/i.test(token)) return html("<h1>Invalid approval link</h1>", 400);
  const candidate = await env.DB.prepare(
    "SELECT * FROM week_setup_candidates WHERE approval_token_hash=? AND status='pending' AND expires_at > CURRENT_TIMESTAMP",
  ).bind(await sha256(token)).first<{ week: number; slate_json: string; expires_at: string }>();
  if (!candidate) return html("<h1>Approval link unavailable</h1><p>This link was used, replaced, or expired.</p>", 404);
  const slate = JSON.parse(candidate.slate_json) as { games: YahooWeekGame[] };
  const games = slate.games.map((game, index) => `<li>${index + 1}. ${escapeHtml(game.favorite)} ${game.spread} ${escapeHtml(game.underdog)}</li>`).join("");
  return html(`<main><h1>Set up FBP Week ${candidate.week}</h1><p>Review the locked Yahoo slate before staging it in D1.</p><ol>${games}</ol><button id="confirm">Set up Week ${candidate.week}</button><p id="status">Expires ${escapeHtml(candidate.expires_at)}.</p></main><script>document.getElementById('confirm').onclick=async()=>{const button=document.getElementById('confirm');button.disabled=true;document.getElementById('status').textContent='Setting up week...';const response=await fetch(location.origin,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'approve-week-setup',token:${JSON.stringify(token)}})});const result=await response.json();document.getElementById('status').textContent=result.ok?'Week staged in D1.':(result.error||'Approval failed.');};</script>`, 200);
};

const resendWeekSetupReview = async (payload: JsonObject, env: Env): Promise<Response> => {
  const token = cleanText(payload.token, 64);
  if (!/^[a-f0-9]{64}$/i.test(token)) return json({ ok: false, error: "This review token is invalid." }, 400, env.CORS_ORIGIN);
  const candidate = await env.DB.prepare(
    "SELECT week,slate_json,expires_at FROM week_setup_candidates WHERE approval_token_hash=? AND status='pending' AND expires_at > CURRENT_TIMESTAMP",
  ).bind(await sha256(token)).first<{ week: number; slate_json: string; expires_at: string }>();
  if (!candidate) return json({ ok: false, error: "This review link is unavailable." }, 404, env.CORS_ORIGIN);
  const games = JSON.parse(candidate.slate_json) as { games: YahooWeekGame[] };
  const reviewUrl = `${env.PUBLIC_API_URL || "https://fbp-api.fbp-api-worker.workers.dev"}/?action=review-week-setup&token=${token}`;
  const email = weekSetupEmail(candidate.week, games.games, reviewUrl, candidate.expires_at, `Review all ${games.games.length} verified Week ${candidate.week} spreads before staging the pool.`);
  const sent = await sendOwnerOperationalEmail(env, `FBP Week ${candidate.week} lines are ready for setup approval`, email.body, email.html);
  return json({ ok: sent, week: candidate.week, expiresAt: candidate.expires_at }, sent ? 200 : 502, env.CORS_ORIGIN);
};

const approveWeekSetupCandidate = async (payload: JsonObject, env: Env): Promise<Response> => {
  const token = cleanText(payload.token, 64);
  if (!/^[a-f0-9]{64}$/i.test(token)) return json({ ok: false, error: "This approval link is invalid." }, 400, env.CORS_ORIGIN);
  const candidate = await env.DB.prepare(
    "SELECT * FROM week_setup_candidates WHERE approval_token_hash=? AND status='pending' AND expires_at > CURRENT_TIMESTAMP",
  ).bind(await sha256(token)).first<{ id: number; season: number; week: number; slate_json: string }>();
  if (!candidate) return json({ ok: false, error: "This approval link was used, replaced, or expired." }, 404, env.CORS_ORIGIN);
  const prior = await latestFinalizedRegularSeasonWeek(env.DB);
  if (!prior || Number(prior.season) !== candidate.season || Number(prior.week) + 1 !== candidate.week) {
    return json({ ok: false, error: "The most recent finalized week no longer matches this approval." }, 409, env.CORS_ORIGIN);
  }
  const slate = JSON.parse(candidate.slate_json) as { games: YahooWeekGame[] };
  const week = await syncApprovedStagedWeek({ season: candidate.season, week: candidate.week, games: slate.games }, env);
  const claimed = await env.DB.prepare("UPDATE week_setup_candidates SET status='approved', approved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'")
    .bind(candidate.id).run();
  if (!claimed.meta.changes) return json({ ok: false, error: "This approval was already completed." }, 409, env.CORS_ORIGIN);
  const notifications = await dispatchWeekNotifications(env, week, new Set<NotificationEvent>(["picksReady"]));
  const push = await dispatchPicksReadyPush(env, week);
  const payoutsSynchronized = await syncPriorWeekPayoutsAfterSetup(env, week);
  if (!payoutsSynchronized) console.warn(`Payout reconciliation could not be completed after Week ${candidate.week} was staged.`);
  const failed = notifications.failed + push.failed;
  return json({ ok: failed === 0, staged: true, payoutsSynchronized, week: candidate.week, ...notifications, push }, failed ? 502 : 200, env.CORS_ORIGIN);
};

const subscribeNotifications = async (request: Request, payload: JsonObject, env: Env): Promise<Response> => {
  const channel = cleanText(payload.channel, 10) as NotificationChannel;
  if (channel !== "email" && channel !== "sms") return json({ ok: false, error: "Choose email or text." }, 400, env.CORS_ORIGIN);
  if (channel === "sms") return json({ ok: false, error: "Text alerts are not available yet. No phone number was saved." }, 503, env.CORS_ORIGIN);
  if (!directEmailConfigured(env) && !relayEmailConfigured(env)) {
    return json({ ok: false, error: "Email alerts are temporarily unavailable while sender setup is completed." }, 503, env.CORS_ORIGIN);
  }
  const playerName = cleanText(payload.playerName, 100).replace(/\s+/g, " ");
  if (!playerName) return json({ ok: false, error: "Choose the player these alerts should follow." }, 400, env.CORS_ORIGIN);
  const normalizedDestination = normalizeNotificationDestination(channel, payload.destination);
  const preferences = parseNotificationPreferences(payload.preferences);
  const picksDueMinutes = Math.max(5, Math.min(300, Math.round(Number(payload.picksDueMinutes) || 60)));
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
  const sent = await sendEmail(env, normalizedDestination, "Verify your FBP alerts",
    `Confirm alerts for ${playerName}:\n\n${verifyUrl}\n\nYou requested alerts at ${requestedAt}\n\nStop these alerts: ${stopUrl}`,
    `<div style="max-width:520px;padding:24px;font-family:Arial,sans-serif;color:#171e26"><h2 style="margin:0 0 12px">Confirm FBP alerts for ${escapeHtml(playerName)}</h2><p style="margin:0 0 22px;line-height:1.5">Verify this email address to activate the alert preferences you selected.</p><p style="margin:0 0 14px"><a href="${escapeHtml(verifyUrl)}" style="display:inline-block;padding:11px 18px;border-radius:5px;background:#d4af37;color:#111;text-decoration:none;font-weight:bold">Verify email</a></p><p style="margin:0 0 24px"><a href="${escapeHtml(stopUrl)}" style="display:inline-block;padding:9px 16px;border:1px solid #9aa4af;border-radius:5px;color:#374151;text-decoration:none">Stop alerts</a></p><p style="margin:0;color:#6b7280;font-size:12px;line-height:1.5">Requested from <a href="${escapeHtml(requestedAt)}" style="color:#52606d">FBP</a>.</p></div>`);
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
  const playerName = cleanText(payload.playerName, 100).replace(/\s+/g, " ");
  if (!playerName) return json({ ok: false, error: "Choose the player these alerts should follow." }, 400, env.CORS_ORIGIN);
  const preferences = parseNotificationPreferences(payload.preferences);
  if (!notificationEvents.some((event) => preferences[event])) return json({ ok: false, error: "Choose at least one alert." }, 400, env.CORS_ORIGIN);
  const picksDueMinutes = Math.max(5, Math.min(300, Math.round(Number(payload.picksDueMinutes) || 60)));
  const values = notificationEvents.map((event) => preferences[event] ? 1 : 0);
  const result = await env.DB.prepare(
    `UPDATE notification_subscriptions SET player_name = ?, picks_ready = ?, picks_due = ?, picks_due_minutes = ?,
      first_place = ?, top_five = ?, top_ten = ?, lead_change = ?, early_window = ?, late_window = ?, before_snf = ?, before_mnf = ?, weekly_result = ?, updated_at = CURRENT_TIMESTAMP
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
    firstPlace: "the latest Current Week standings first show you in 1st place",
    topFive: "your Current Week rank moved into the top 5",
    topTen: "your Current Week rank moved into the top 10",
    leadChange: "the pool lead changed",
    earlyWindow: "all Sunday 1 PM games are final",
    lateWindow: "the Sunday afternoon games are final",
    beforeSnf: "the Sunday afternoon games are final and Sunday Night Football starts within 35 minutes",
    beforeMnf: "Monday Night Football starts within 35 minutes",
    weeklyResult: "the week has been finalized",
  };
  return `Why you received this now: ${explanations[event]}. Notifications are checked every 5 minutes.`;
};

const weeklyStandingsSummary = (players: JsonObject[]): string => {
  if (!players.length) return "Current weekly standings\nNo player cards have been submitted yet.";
  const rows = players.map((player, index) => `${Number(player.rank) || index + 1}. ${player.name} — ${player.wins || 0}-${player.losses || 0}`);
  return `Current weekly standings\n${rows.join("\n")}`;
};

const weeklyResultSummary = (players: JsonObject[], followedName: string, seasonStandings: { before: SeasonStanding[]; after: SeasonStanding[] } | null): string => {
  const ordered = [...players].sort((left, right) => Number(left.rank) - Number(right.rank));
  const followedIndex = ordered.findIndex((player) => String(player.name).toLowerCase() === followedName.toLowerCase());
  const followed = followedIndex >= 0 ? ordered[followedIndex] : null;
  const winner = ordered[0];
  const winnerRecord = winner ? `${winner.wins || 0}-${winner.losses || 0}` : "";
  const followedRecord = followed ? `${followed.wins || 0}-${followed.losses || 0}` : "";
  const headline = followed
    ? `${followed.name}: ${followedRecord} this week · #${followedIndex + 1} in the pool. ${winner?.name || "The leader"} won ${winnerRecord}.`
    : `${winner?.name || "The leader"} won the week at ${winnerRecord}.`;
  const before = seasonStandings?.before.find((standing) => standing.name.toLowerCase() === followedName.toLowerCase()) || null;
  const after = seasonStandings?.after.find((standing) => standing.name.toLowerCase() === followedName.toLowerCase()) || null;
  return `${headline}\n${seasonRankMovementSummary(before, after)}`;
};

const scoreArchivedSeason = async (
  db: D1Database,
  week: Record<string, unknown>,
): Promise<{ before: SeasonStanding[]; after: SeasonStanding[] }> => {
  const archives = await db.prepare(
    `SELECT w.week, a.payload_json
     FROM completed_week_archives a
     JOIN weeks w ON w.id = a.week_id
     WHERE w.season = ? AND w.phase = 'REGULAR_SEASON' AND w.week <= ?
     ORDER BY w.week`,
  ).bind(week.season, week.week).all<{ week: number; payload_json: string }>();
  const before = new Map<string, { name: string; wins: number; losses: number }>();
  const after = new Map<string, { name: string; wins: number; losses: number }>();
  const addScores = (target: Map<string, { name: string; wins: number; losses: number }>, payload: JsonObject): void => {
    const games = Array.isArray(payload.games) ? payload.games.map((game) => ({
      favorite: String((game as JsonObject).favorite || ""),
      underdog: String((game as JsonObject).underdog || ""),
      spread: Number((game as JsonObject).spread),
      status: String((game as JsonObject).status || "PREGAME") as ScoringGame["status"],
      favoriteScore: Number((game as JsonObject).favoriteScore),
      underdogScore: Number((game as JsonObject).underdogScore),
    })) : [];
    const cards = Array.isArray(payload.submissions) ? payload.submissions.map((submission) => ({
      name: String((submission as JsonObject).name || ""),
      weekName: String((submission as JsonObject).weekName || ""),
      picks: Array.isArray((submission as JsonObject).picks) ? ((submission as JsonObject).picks as unknown[]).map(String) : [],
      bestBet: String((submission as JsonObject).bestBet || ""),
      tiebreaker: Number((submission as JsonObject).tiebreaker),
    })).filter((card) => card.name && card.picks.length === games.length) : [];
    scoreWeekWithoutProbabilities(cards, games, Number(payload.actualTiebreaker)).forEach((player) => {
      const key = player.name.toLowerCase();
      const record = target.get(key) || { name: player.name, wins: 0, losses: 0 };
      record.wins += player.wins;
      record.losses += player.losses;
      target.set(key, record);
    });
  };
  const rank = (records: Map<string, { name: string; wins: number; losses: number }>): SeasonStanding[] =>
    [...records.values()]
      .sort((left, right) => right.wins - left.wins || left.losses - right.losses || left.name.localeCompare(right.name))
      .map((record, index) => ({ ...record, rank: index + 1 }));
  for (const archive of archives.results) {
    const payload = JSON.parse(archive.payload_json) as JsonObject;
    if (Number(archive.week) === Number(week.week)) {
      before.forEach((record, key) => after.set(key, { ...record }));
      addScores(after, payload);
    } else {
      addScores(before, payload);
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

const PLAYER_EMAIL_NOTIFICATIONS_ENABLED = false;

const dispatchWeekNotifications = async (
  env: Env,
  week: Record<string, unknown>,
  onlyEvents?: Set<NotificationEvent>,
): Promise<NotificationDispatchResult> => {
  const result = { sent: 0, skipped: 0, failed: 0 };
  if (!PLAYER_EMAIL_NOTIFICATIONS_ENABLED) return result;
  if (!directEmailConfigured(env) && !relayEmailConfigured(env)) return result;
  const games = await getWeekConfig(env.DB, Number(week.id));
  const eventSet = onlyEvents || new Set(scheduledNotificationEvents(new Date(), games, String(week.status)));
  const current = await buildCurrentWeek(env.DB, week);
  const players = Array.isArray(current.players) ? current.players as JsonObject[] : [];
  const hasStarted = games.some((game) => ["LIVE", "FINAL"].includes(String(game.state)));
  if (!onlyEvents && hasStarted && players.length) eventSet.add("firstPlace");
  if (!eventSet.size) return result;
  const seasonStandings = eventSet.has("weeklyResult") ? await scoreArchivedSeason(env.DB, week) : null;
  const subscriptions = await env.DB.prepare(
    "SELECT * FROM notification_subscriptions WHERE status = 'active' AND channel = 'email' AND manage_token IS NOT NULL",
  ).all();
  const publicApiUrl = (env.PUBLIC_API_URL || "https://fbp-api.fbp-api-worker.workers.dev").replace(/\/$/, "");
  for (const subscription of subscriptions.results) {
    const followedName = String(subscription.player_name);
    const followed = players.find((player) => String(player.name).toLowerCase() === followedName.toLowerCase());
    const rank = followed ? players.indexOf(followed) + 1 : 0;
    const subscriptionEvents = new Set(eventSet);
    if (!onlyEvents && picksDueReminderIsEligible(new Date(), games, String(week.status), Number(subscription.picks_due_minutes) || 60)) subscriptionEvents.add("picksDue");
    for (const event of subscriptionEvents) {
      if (!Number(subscription[notificationPreferenceColumns[event]])) continue;
      if (event === "picksDue" && (followed || followedName === "FBP pool")) continue;
      if (event === "firstPlace" && (!followed || rank !== 1)) continue;
      const deduplicationKey = `${event}:${week.id}`;
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
      const eventSummary = event === "picksDue"
        ? `${followedName}, your Week ${week.week} picks are not in yet.\n\nFirst kickoff: ${new Date(firstKickoff).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}\nSubmit before kickoff to avoid missing the opening game.`
        : event === "picksReady" ? picksReadySummary(games, week.week) : event === "weeklyResult" ? weeklyResultSummary(players, followedName, seasonStandings) : standings;
      const timingExplanation = notificationTimingExplanation(event, Number(subscription.picks_due_minutes) || 60);
      const body = event === "weeklyResult"
        ? `${eventSummary}\n\n${timingExplanation}\n\nOpen FBP: ${env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/"}\n\nStop all FBP alerts: ${stopUrl}`
        : `${notificationEventLabels[event]}\n\n${eventSummary}\n\n${timingExplanation}\n\nOpen FBP: ${env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/"}\n\nStop all FBP alerts: ${stopUrl}`;
      const sent = await sendEmail(env, String(subscription.destination),
        event === "weeklyResult" ? `FBP Week ${week.week}: final standings` : `FBP Week ${week.week}: ${notificationEventLabels[event]}`,
        body);
      await env.DB.prepare(
        "UPDATE notification_deliveries SET status = ?, sent_at = ?, error_message = ? WHERE subscription_id = ? AND deduplication_key = ?",
      ).bind(sent ? "sent" : "failed", sent ? new Date().toISOString() : null, sent ? null : "Email relay rejected the message.", subscription.id, deduplicationKey).run();
      if (sent) result.sent += 1;
      else result.failed += 1;
    }
  }
  return result;
};

const syncApprovedStagedWeek = async (payload: JsonObject, env: Env): Promise<Record<string, unknown>> => {
  const season = Number(payload.season), weekNumber = Number(payload.week);
  if (!Number.isInteger(season) || !Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 18) {
    throw new Error("A valid regular-season season and week are required.");
  }
  const games = Array.isArray(payload.games) ? payload.games as JsonObject[] : [];
  if (!games.length || games.length > 16) throw new Error("The staged slate must contain between 1 and 16 games.");
  const normalizedGames = games.map((game, index) => {
    const externalId = cleanText(game.gameId || game.externalId, 100);
    const kickoff = cleanText(game.kickoff || game.startTime, 100);
    const favorite = normalizeNflAbbreviation(cleanText(game.favorite, 20));
    const underdog = normalizeNflAbbreviation(cleanText(game.underdog, 20));
    const home = normalizeNflAbbreviation(cleanText(game.home || (game.homeTeam as JsonObject | undefined)?.abbreviation, 20));
    const away = normalizeNflAbbreviation(cleanText(game.away || (game.awayTeam as JsonObject | undefined)?.abbreviation, 20));
    const spread = Number(game.spread);
    if (!externalId || !kickoff || !Number.isFinite(Date.parse(kickoff)) || !favorite || !underdog || !home || !away || !Number.isFinite(spread)) {
      throw new Error(`Game ${index + 1} is missing a valid ID, kickoff, matchup, or spread.`);
    }
    return { externalId, kickoff, favorite, underdog, home, away, spread, metadata: JSON.stringify({ ...game, favorite, underdog, home, away }) };
  });
  const existing = await findWeek(env.DB, season, weekNumber, "REGULAR_SEASON");
  if (existing) {
    const submissions = await env.DB.prepare("SELECT COUNT(*) AS count FROM submissions WHERE week_id = ? AND superseded_at IS NULL")
      .bind(existing.id).first<{ count: number }>();
    if (Number(submissions?.count)) throw new Error("The staged week already has picks and cannot be replaced by an approval link.");
  }
  await env.DB.prepare(
    "UPDATE weeks SET status = 'finalized', finalized_at = COALESCE(finalized_at, CURRENT_TIMESTAMP) WHERE phase = 'REGULAR_SEASON' AND status IN ('staged', 'open', 'live', 'finalizing') AND NOT (season = ? AND week = ?)",
  ).bind(season, weekNumber).run();
  await env.DB.prepare(
    "INSERT INTO weeks (season, week, phase, status) VALUES (?, ?, 'REGULAR_SEASON', 'staged') ON CONFLICT (season, week, phase) DO UPDATE SET status = 'staged', finalized_at = NULL",
  ).bind(season, weekNumber).run();
  const staged = await findWeek(env.DB, season, weekNumber, "REGULAR_SEASON");
  if (!staged) throw new Error("The staged week could not be synchronized.");
  await env.DB.prepare("DELETE FROM games WHERE week_id = ?").bind(staged.id).run();
  const statements: D1PreparedStatement[] = [];
  normalizedGames.forEach((game, index) => {
    statements.push(env.DB.prepare(
      "INSERT INTO games (week_id, game_index, external_id, kickoff_at, favorite, underdog, spread, home_team, away_team, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(staged.id, index, game.externalId, game.kickoff, game.favorite, game.underdog, game.spread, game.home, game.away, game.metadata));
  });
  await env.DB.batch(statements);
  return staged;
};

const releasePicksReady = async (payload: JsonObject, env: Env): Promise<Response> => {
  if (!env.EMAIL_RELAY_SECRET?.trim() || cleanText(payload.secret, 200) !== env.EMAIL_RELAY_SECRET.trim()) {
    return json({ ok: false, error: "Unauthorized." }, 401, env.CORS_ORIGIN);
  }
  const week = await syncApprovedStagedWeek(payload, env);
  const result = await dispatchWeekNotifications(env, week, new Set<NotificationEvent>(["picksReady"]));
  const payoutsSynchronized = await syncPriorWeekPayoutsAfterSetup(env, week);
  if (!payoutsSynchronized) console.warn(`Payout reconciliation could not be completed after Week ${Number(week.week)} was staged.`);
  return json({ ok: result.failed === 0, payoutsSynchronized, ...result }, result.failed ? 502 : 200, env.CORS_ORIGIN);
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

const handleAnalytics = async (payload: JsonObject, request: Request, env: Env): Promise<Response> => {
  const event = cleanText(payload.event, 30);
  const allowedEvents = new Set(["page_view", "picks_started", "submission", "view_duration"]);
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
    durationSeconds: Math.max(0, Math.min(86400, Number(payload.durationSeconds) || 0)),
  };
  const geography = request.cf;
  const latitude = Number(geography?.latitude), longitude = Number(geography?.longitude);
  await env.DB
    .prepare(
      `INSERT INTO analytics_events
       (browser_id, session_id, event, view_name, context_json, country, region, region_code, continent, city, latitude, longitude)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      browserId, sessionId, event, view, JSON.stringify(context),
      geography?.country || "", geography?.region || "", geography?.regionCode || "", geography?.continent || "", geography?.city || "",
      Number.isFinite(latitude) ? latitude : null, Number.isFinite(longitude) ? longitude : null,
    )
    .run();
  return json({ ok: true }, 200, env.CORS_ORIGIN);
};

const submitCard = async (payload: JsonObject, env: Env): Promise<Response> => {
  const rawName = cleanText(payload.name, 100);
  const name = rawName.replace(/\s+/g, " ");
  const weekName = cleanText(payload.weekName, 200);
  const picks = Array.isArray(payload.picks) ? payload.picks.map((pick) => cleanText(pick, 20)) : [];
  const bestBet = cleanText(payload.bestBet, 20);
  const tiebreaker = Number(payload.tiebreaker);
  const season = Number(payload.season || 2026);
  const weekNumber = Number(payload.week || 1);
  const phase = cleanText(payload.phase || (payload.mode === "test" ? "PRESEASON" : "REGULAR_SEASON"), 30);
  if (!name || !weekName || !picks.length || picks.some((pick) => !pick) || !bestBet) {
    return json({ ok: false, error: "Name, week name, every pick, best bet, and tiebreaker are required." }, 400, env.CORS_ORIGIN);
  }
  if (!Number.isFinite(tiebreaker) || tiebreaker < -100 || tiebreaker > 1200) {
    return json({ ok: false, error: "The tiebreaker must be a number from -100 through 1200." }, 400, env.CORS_ORIGIN);
  }
  if (!Number.isInteger(season) || !Number.isInteger(weekNumber)) {
    return json({ ok: false, error: "Season and week must be integers." }, 400, env.CORS_ORIGIN);
  }
  const week = await findWeek(env.DB, season, weekNumber, phase);
  if (!week || week.status === "finalized" || week.status === "finalizing") {
    return json({ ok: false, error: "This week is not open for submissions." }, 409, env.CORS_ORIGIN);
  }
  const gameRows = await env.DB
    .prepare("SELECT id, game_index, favorite, underdog, spread, kickoff_at FROM games WHERE week_id = ? ORDER BY game_index")
    .bind(week.id)
    .all();
  if (!gameRows.results.length || picks.length !== gameRows.results.length) {
    return json({ ok: false, error: "Picks must match the currently staged week." }, 400, env.CORS_ORIGIN);
  }
  const validPicks = picks.every((pick, index) => {
    const game = gameRows.results[index];
    return pick === game.favorite || pick === game.underdog;
  });
  const bestBetGameIndex = picks.indexOf(bestBet);
  if (!validPicks || bestBetGameIndex < 0) {
    return json({ ok: false, error: "A pick or best bet does not match the staged games." }, 400, env.CORS_ORIGIN);
  }

  const priorSubmission = await env.DB.prepare("SELECT s.id FROM submissions s JOIN players p ON p.id=s.player_id WHERE s.week_id=? AND p.canonical_name=? COLLATE NOCASE AND s.superseded_at IS NULL")
    .bind(week.id, name).first<{ id: number }>();
  const priorPlayer = await env.DB.prepare("SELECT id FROM players WHERE canonical_name=? COLLATE NOCASE").bind(name).first<{ id: number }>();
  await env.DB.prepare("INSERT INTO players (canonical_name) VALUES (?) ON CONFLICT (canonical_name) DO NOTHING").bind(name).run();
  const player = await env.DB
    .prepare("SELECT id, canonical_name FROM players WHERE canonical_name = ? COLLATE NOCASE")
    .bind(name)
    .first<{ id: number; canonical_name: string }>();
  if (!player) throw new Error("Player identity could not be stored.");
  const submittedAt = new Date().toISOString();
  const statements = [
    env.DB.prepare("UPDATE submissions SET superseded_at = ? WHERE week_id = ? AND player_id = ? AND superseded_at IS NULL")
      .bind(submittedAt, week.id, player.id),
    env.DB.prepare(
      `INSERT INTO submissions
       (week_id, player_id, submitted_name, week_name, best_bet_game_index, tiebreaker, source, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(week.id, player.id, rawName, weekName, bestBetGameIndex, tiebreaker, payload.mode === "test" ? "website-test" : "website", submittedAt),
    ...gameRows.results.map((game, index) => env.DB.prepare(
      `INSERT INTO submission_picks (submission_id, game_id, picked_team)
       SELECT id, ?, ? FROM submissions
       WHERE week_id = ? AND player_id = ? AND submitted_at = ?`,
    ).bind(game.id, picks[index], week.id, player.id, submittedAt)),
  ];
  await env.DB.batch(statements);
  const submissionKey = `admin-submission:${week.id}:${player.id}:${submittedAt}`;
  await sendAdministratorPushOnce(env, priorSubmission ? "adminPickReplaced" : "adminPickSubmitted", submissionKey,
    priorSubmission ? `Picks replaced - Week ${weekNumber}` : `Picks submitted - Week ${weekNumber}`,
    `${player.canonical_name} ${priorSubmission ? "replaced" : "submitted"} their picks.`, Number(week.id));
  if (!priorPlayer) await sendAdministratorPushOnce(env, "adminNewPlayer", `admin-new-player:${player.id}`, "New player joined", `${player.canonical_name} submitted their first FBP picks.`, Number(week.id));
  const firstKickoff = Math.min(...gameRows.results.map((game) => Date.parse(String(game.kickoff_at))));
  if (Number.isFinite(firstKickoff) && Date.parse(submittedAt) > firstKickoff) await sendAdministratorPushOnce(env, "adminLateSubmission", `admin-late-submission:${week.id}:${player.id}:${submittedAt}`, `Late picks - Week ${weekNumber}`, `${player.canonical_name} submitted picks after the first kickoff.`, Number(week.id));
  const confirmationEmailToken = payload.mode === "test" ? "" : await preparePickSubmissionConfirmation(env, {
    name,
    weekName,
    picks,
    stagedGames: gameRows.results.map((game) => ({
      favorite: cleanText(game.favorite, 20),
      spread: Number(game.spread),
      underdog: cleanText(game.underdog, 20),
    })),
    bestBet,
    tiebreaker,
    week: weekNumber,
    submittedAt,
  });
  return json({
    ok: true,
    testMode: payload.mode === "test",
    submittedAt,
    confirmationEmailToken,
    identity: {
      status: rawName === player.canonical_name ? "known" : "suggestion",
      submittedName: player.canonical_name,
      suggestedName: "",
      reason: "",
      canonicalizedFrom: rawName === player.canonical_name ? "" : rawName,
    },
  }, 200, env.CORS_ORIGIN);
};

const correctSubmission = async (payload: JsonObject, env: Env): Promise<Response> => {
  const originalName = cleanText(payload.originalName, 100).replace(/\s+/g, " ");
  const correctedName = cleanText(payload.correctedName, 100).replace(/\s+/g, " ");
  const correctedWeekName = cleanText(payload.correctedWeekName, 200).replace(/\s+/g, " ");
  const submittedAt = cleanText(payload.submittedAt, 40);
  const season = Number(payload.season);
  const weekNumber = Number(payload.week);
  const phase = payload.mode === "test" ? "PRESEASON" : "REGULAR_SEASON";
  if (!originalName || !correctedName || !submittedAt || !Number.isInteger(season) || !Number.isInteger(weekNumber)) {
    return json({ ok: false, error: "The submission timestamp, original name, corrected name, season, and week are required." }, 400, env.CORS_ORIGIN);
  }
  if (!Number.isFinite(Date.parse(submittedAt))) {
    return json({ ok: false, error: "The submission timestamp is invalid." }, 400, env.CORS_ORIGIN);
  }
  const week = await findWeek(env.DB, season, weekNumber, phase);
  if (!week) return json({ ok: false, error: "The submitted entry could not be found." }, 404, env.CORS_ORIGIN);
  const submission = await env.DB
    .prepare(
      `SELECT s.id, s.player_id, s.week_name, p.canonical_name
       FROM submissions s JOIN players p ON p.id = s.player_id
       WHERE s.week_id = ? AND s.submitted_at = ?
         AND p.canonical_name = ? COLLATE NOCASE
       ORDER BY s.id DESC LIMIT 1`,
    )
    .bind(week.id, submittedAt, originalName)
    .first<{ id: number; player_id: number; week_name: string; canonical_name: string }>();
  if (!submission) {
    return json({ ok: false, error: `The Week ${weekNumber} submission for ${originalName} could not be found.` }, 404, env.CORS_ORIGIN);
  }
  await env.DB.prepare("INSERT INTO players (canonical_name) VALUES (?) ON CONFLICT (canonical_name) DO NOTHING").bind(correctedName).run();
  const correctedPlayer = await env.DB
    .prepare("SELECT id, canonical_name FROM players WHERE canonical_name = ? COLLATE NOCASE")
    .bind(correctedName)
    .first<{ id: number; canonical_name: string }>();
  if (!correctedPlayer) throw new Error("Corrected player identity could not be stored.");
  const statements = [
    env.DB.prepare("UPDATE submissions SET player_id = ?, week_name = ? WHERE id = ?")
      .bind(correctedPlayer.id, correctedWeekName || submission.week_name, submission.id),
  ];
  if (submission.canonical_name !== correctedPlayer.canonical_name) {
    statements.push(env.DB.prepare(
      "INSERT INTO submission_corrections (submission_id, field, old_value, new_value) VALUES (?, 'name', ?, ?)",
    ).bind(submission.id, submission.canonical_name, correctedPlayer.canonical_name));
  }
  if (correctedWeekName && correctedWeekName !== submission.week_name) {
    statements.push(env.DB.prepare(
      "INSERT INTO submission_corrections (submission_id, field, old_value, new_value) VALUES (?, 'weekName', ?, ?)",
    ).bind(submission.id, submission.week_name, correctedWeekName));
  }
  await env.DB.batch(statements);
  return json({
    ok: true,
    correctedName: correctedPlayer.canonical_name,
    correctedWeekName,
    identity: {
      status: "known",
      submittedName: correctedPlayer.canonical_name,
      suggestedName: "",
      reason: "",
      canonicalizedFrom: correctedName === correctedPlayer.canonical_name ? "" : correctedName,
    },
  }, 200, env.CORS_ORIGIN);
};

const storeRaceSnapshot = async (payload: JsonObject, env: Env): Promise<Response> => {
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
  const gameState = buildRaceGameState(games as Record<string, unknown>[]);
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
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(week.id, capturedAt, player.name, player.winProbability, player.pathsToVictory,
      scored?.winPercent || 0, gameStateJson);
  }));
  return json({ ok: true, stored: true, capturedAt }, 201, env.CORS_ORIGIN);
};

const handlePost = async (request: Request, env: Env): Promise<Response> => {
  const payload = await parsePayload(request);
  const action = cleanText(payload.action, 50);
  if (action === "send-pick-confirmation-email") return relayPickConfirmationEmail(env, payload);
  if (action === "approve-week-setup") return approveWeekSetupCandidate(payload, env);
  if (action === "resend-week-setup-review") return resendWeekSetupReview(payload, env);
  if (action === "subscribe-push") return savePushDevice(payload, env);
  if (action === "link-push-player") return linkPushDevicePlayer(payload, env);
  if (action === "disable-push") return disablePushDevice(payload, env);
  if (action === "admin-push-test") {
    const expectedSecret = env.ADMIN_PUSH_TEST_SECRET?.trim();
    if (!expectedSecret || request.headers.get("X-Admin-Push-Test") !== expectedSecret) {
      return json({ ok: false, error: "Administrator authorization required." }, 403, env.CORS_ORIGIN);
    }
    const week = await activeWeek(env.DB);
    if (!week) return json({ ok: false, error: "No active week is available." }, 409, env.CORS_ORIGIN);
    const current = await buildCurrentWeek(env.DB, week);
    const players = Array.isArray(current.players) ? current.players as JsonObject[] : [];
    const administrator = env.ADMIN_PUSH_PLAYER?.trim() || "Jim";
    await sendAdministratorPushOnce(env, "adminWeeklyResultTest", `admin-weekly-result-test:${Date.now()}:${crypto.randomUUID()}`,
      `FBP Week ${week.week}: Weekly result test`, weeklyResultSummary(players, administrator, null));
    return json({ ok: true, week: week.week }, 200, env.CORS_ORIGIN);
  }
  if (action === "notification-subscribers") return listNotificationSubscribers(payload, env);
  if (action === "release-picks-ready") return releasePicksReady(payload, env);
  if (action === "log-visit") return handleAnalytics(payload, request, env);
  if (action === "subscribe-notifications") return subscribeNotifications(request, payload, env);
  if (action === "update-notifications") return updateNotificationPreferences(payload, env);
  if (action === "correct-submission-name") return correctSubmission(payload, env);
  if (action === "race-snapshot") return storeRaceSnapshot(payload, env);
  if (action === "assess-player-identity") {
    const submittedName = cleanText(payload.name, 100).replace(/\s+/g, " ");
    const player = submittedName
      ? await env.DB.prepare("SELECT canonical_name FROM players WHERE canonical_name = ? COLLATE NOCASE").bind(submittedName).first<{ canonical_name: string }>()
      : null;
    return json({
      ok: true,
      identity: {
        submittedName: player?.canonical_name || submittedName,
        canonicalizedFrom: player && player.canonical_name !== submittedName ? submittedName : "",
        knownPlayer: Boolean(player),
      },
    }, 200, env.CORS_ORIGIN);
  }
  if (!action) {
    const response = await submitCard(payload, env);
    if (!response.ok) {
      const detail = await response.clone().json() as { error?: unknown };
      const name = cleanText(payload.name, 100).replace(/\s+/g, " ");
      if (name) {
        await sendAdministratorPushOnce(env, "adminSubmissionRejected", `admin-submission-rejected:${Date.now()}:${crypto.randomUUID()}`, "Pick submission rejected", `${name}: ${cleanText(detail.error, 180) || "The submission was rejected."}`);
      }
    }
    return response;
  }
  return json({ ok: false, error: "Unknown action." }, 400, env.CORS_ORIGIN);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return json({ ok: true }, 200, env.CORS_ORIGIN);
    try {
      if (request.method === "GET") return await handleGet(request, env);
      if (request.method === "POST") return await handlePost(request, env);
      return json({ ok: false, error: "Method not allowed." }, 405, env.CORS_ORIGIN);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error.";
      return json({ ok: false, error: message }, 400, env.CORS_ORIGIN);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const weekBeforeRefresh = await activeWeek(env.DB);
    const refresh = await refreshActiveGameStates(env.DB);
    if (!weekBeforeRefresh) {
      await createWeekSetupCandidate(env);
      return;
    }
    let refreshedWeek = await findWeek(env.DB, Number(weekBeforeRefresh.season), Number(weekBeforeRefresh.week), "REGULAR_SEASON");
    if (refreshedWeek?.status === "finalizing") {
      const finalized = await finalizeWeek(env, refreshedWeek);
      if (finalized && !(await syncFinalizedPayouts(env))) {
        console.warn("Finalized payout sync was not acknowledged by the Apps Script relay.");
      }
    }
    refreshedWeek = await findWeek(env.DB, Number(weekBeforeRefresh.season), Number(weekBeforeRefresh.week), "REGULAR_SEASON");
    if (refreshedWeek) {
      await dispatchWeekNotifications(env, refreshedWeek);
      await dispatchWeekPushNotifications(env, refreshedWeek, refresh.scoreChanges);
      if (!(await syncPriorWeekPayoutsAfterSetup(env, refreshedWeek))) {
        console.warn(`Payout reconciliation could not be completed while Week ${Number(refreshedWeek.week)} is active.`);
      }
    }
    await createWeekSetupCandidate(env);
  },
} satisfies ExportedHandler<Env>;
