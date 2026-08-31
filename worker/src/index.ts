import { scoreWeekWithoutProbabilities, type PlayerCard, type ScoringGame } from "./scoring";
import { espnEventId, fetchEspnGame, isRefreshWindow, parseEspnGame, type StoredGame } from "./espn";
import { validateRaceSnapshotPlayers } from "./race";
import { maskNotificationDestination, normalizeNotificationDestination, notificationEvents, notificationPreferenceColumns, parseNotificationPreferences, picksDueReminderIsEligible, scheduledNotificationEvents, type NotificationChannel, type NotificationEvent } from "./notifications";

interface Env {
  DB: D1Database;
  CORS_ORIGIN: string;
  EMAIL_RELAY_URL?: string;
  EMAIL_RELAY_SECRET?: string;
  PUBLIC_API_URL?: string;
  PUBLIC_SITE_URL?: string;
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

const refreshActiveGameStates = async (db: D1Database): Promise<{ refreshed: number; skipped: string }> => {
  const week = await activeWeek(db);
  if (!week) return { refreshed: 0, skipped: "no-active-week" };
  const result = await db
    .prepare(
      `SELECT id, external_id, favorite, underdog, home_team, away_team, metadata_json
       FROM games WHERE week_id = ? ORDER BY game_index`,
    )
    .bind(week.id)
    .all();
  const games: StoredGame[] = result.results.map((row) => ({
    id: Number(row.id),
    externalId: String(row.external_id),
    favorite: String(row.favorite),
    underdog: String(row.underdog),
    homeTeam: String(row.home_team),
    awayTeam: String(row.away_team),
    metadata: JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>,
  }));
  if (!games.length) return { refreshed: 0, skipped: "no-games" };
  if (!isRefreshWindow(games)) return { refreshed: 0, skipped: "outside-game-window" };
  const eventIds = games.map(espnEventId);
  if (eventIds.some((eventId) => !eventId)) return { refreshed: 0, skipped: "missing-espn-event-id" };
  const payloads = await Promise.all(eventIds.map(fetchEspnGame));
  const updatedAt = new Date().toISOString();
  const updates = games.map((game, index) => parseEspnGame(payloads[index], game));
  const lastGameIndex = games.reduce((latest, game, index) => game.externalId > games[latest].externalId ? index : latest, 0);
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

const finalizeWeek = async (db: D1Database, week: Record<string, unknown>): Promise<boolean> => {
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
    actualTiebreaker: actualTiebreaker ?? "",
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
  if (action === "notification-status") return json({
    ok: true,
    channels: { email: Boolean(env.EMAIL_RELAY_URL && env.EMAIL_RELAY_SECRET), sms: false },
  }, 200, env.CORS_ORIGIN);

  if (action === "verify-notifications" || action === "unsubscribe-notifications") {
    const rawToken = url.searchParams.get("token") || "";
    if (!/^[a-f0-9]{64}$/.test(rawToken)) return html("<h1>Invalid notification link</h1><p>This link is incomplete or has expired.</p>", 400);
    const tokenHash = await sha256(rawToken);
    if (action === "verify-notifications") {
      const subscription = await env.DB.prepare(
        "SELECT id, channel, destination, status FROM notification_subscriptions WHERE verification_token_hash = ? AND status IN ('pending', 'active')",
      ).bind(tokenHash).first<{ id: number; channel: NotificationChannel; destination: string; status: string }>();
      if (!subscription) return html("<h1>Verification link expired</h1><p>Return to FBP and request a new verification email.</p>", 404);
      if (subscription.status === "active") {
        return html(`<h1>FBP alerts are already on</h1><p>${escapeHtml(maskNotificationDestination(subscription.channel, subscription.destination))} is verified. You can close this page.</p>`);
      }
      await env.DB.prepare(
        "UPDATE notification_subscriptions SET status = 'active', verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      ).bind(subscription.id).run();
      return html(`<h1>FBP alerts are on</h1><p>${escapeHtml(maskNotificationDestination(subscription.channel, subscription.destination))} is verified. You can close this page.</p>`);
    }
    const result = await env.DB.prepare(
      "UPDATE notification_subscriptions SET status = 'unsubscribed', unsubscribed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE manage_token_hash = ?",
    ).bind(tokenHash).run();
    return result.meta.changes
      ? html("<h1>FBP alerts stopped</h1><p>You will not receive additional messages. You can subscribe again from the FBP website.</p>")
      : html("<h1>Unsubscribe link expired</h1><p>No active notification contact was found for this link.</p>", 404);
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
    const week = await activeWeek(env.DB);
    if (!week) return json({ ok: false, error: "No regular-season week is staged." }, 404, env.CORS_ORIGIN);
    const body = await buildCurrentWeek(env.DB, week);
    return json(body, 200, env.CORS_ORIGIN);
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

const sendRelayEmail = async (env: Env, to: string, subject: string, body: string): Promise<boolean> => {
  if (!env.EMAIL_RELAY_URL?.trim() || !env.EMAIL_RELAY_SECRET?.trim()) return false;
  const response = await fetch(env.EMAIL_RELAY_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ action: "send-notification-email", secret: env.EMAIL_RELAY_SECRET, to, subject, body }),
  });
  const result = await response.json().catch(() => null) as { ok?: boolean } | null;
  return response.ok && result?.ok === true;
};

const subscribeNotifications = async (request: Request, payload: JsonObject, env: Env): Promise<Response> => {
  const channel = cleanText(payload.channel, 10) as NotificationChannel;
  if (channel !== "email" && channel !== "sms") return json({ ok: false, error: "Choose email or text." }, 400, env.CORS_ORIGIN);
  if (channel === "sms") return json({ ok: false, error: "Text alerts are not available yet. No phone number was saved." }, 503, env.CORS_ORIGIN);
  if (!env.EMAIL_RELAY_URL?.trim() || !env.EMAIL_RELAY_SECRET?.trim()) {
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
  const sent = await sendRelayEmail(env, normalizedDestination, "Verify your FBP alerts",
    `Confirm alerts for ${playerName}:\n\n${workerOrigin}/?action=verify-notifications&token=${verificationToken}\n\nYou requested alerts at ${env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/"}\n\nStop these alerts: ${workerOrigin}/?action=unsubscribe-notifications&token=${manageToken}`);
  if (!sent) {
    await env.DB.prepare(
      "UPDATE notification_subscriptions SET verification_token_hash = NULL, verification_sent_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE channel = ? AND normalized_destination = ? AND status = 'pending'",
    ).bind(channel, normalizedDestination).run();
    return json({ ok: false, error: "The verification email could not be sent. Try again later." }, 502, env.CORS_ORIGIN);
  }
  return json({ ok: true, status: "pending", maskedDestination: maskNotificationDestination(channel, normalizedDestination) }, 202, env.CORS_ORIGIN);
};

const notificationEventLabels: Record<NotificationEvent, string> = {
  picksReady: "Picks are ready",
  picksDue: "Picks due reminder",
  firstPlace: "First-place update",
  earlyWindow: "Early games complete",
  lateWindow: "Late games complete",
  beforeSnf: "Before Sunday Night Football",
  beforeMnf: "Before Monday Night Football",
  weeklyResult: "Weekly result",
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
  return `The Week ${weekNumber} slate is open. All ${games.length} games and point spreads are posted.\n\n${gameLines.join("\n").trimEnd()}`;
};

const dispatchWeekNotifications = async (env: Env, week: Record<string, unknown>): Promise<void> => {
  if (!env.EMAIL_RELAY_URL?.trim() || !env.EMAIL_RELAY_SECRET?.trim()) return;
  const games = await getWeekConfig(env.DB, Number(week.id));
  const eventSet = new Set(scheduledNotificationEvents(new Date(), games, String(week.status)));
  const current = await buildCurrentWeek(env.DB, week);
  const players = Array.isArray(current.players) ? current.players as JsonObject[] : [];
  const hasStarted = games.some((game) => ["LIVE", "FINAL"].includes(String(game.state)));
  if (hasStarted && players.length) eventSet.add("firstPlace");
  if (!eventSet.size) return;
  const subscriptions = await env.DB.prepare(
    "SELECT * FROM notification_subscriptions WHERE status = 'active' AND channel = 'email' AND manage_token IS NOT NULL",
  ).all();
  const publicApiUrl = (env.PUBLIC_API_URL || "https://fbp-api.fbp-api-worker.workers.dev").replace(/\/$/, "");
  const pendingGames = games.filter((game) => game.state !== "FINAL").length;
  for (const subscription of subscriptions.results) {
    const followedName = String(subscription.player_name);
    const followed = players.find((player) => String(player.name).toLowerCase() === followedName.toLowerCase());
    const rank = followed ? players.indexOf(followed) + 1 : 0;
    const subscriptionEvents = new Set(eventSet);
    if (picksDueReminderIsEligible(new Date(), games, String(week.status), Number(subscription.picks_due_minutes) || 60)) subscriptionEvents.add("picksDue");
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
        if (prior?.status !== "failed") continue;
        await env.DB.prepare(
          "UPDATE notification_deliveries SET status = 'queued', error_message = NULL WHERE subscription_id = ? AND deduplication_key = ?",
        ).bind(subscription.id, deduplicationKey).run();
      }
      const leader = players[0];
      const summary = followed
        ? `${followedName} is #${rank} of ${players.length} at ${followed.wins || 0}-${followed.losses || 0}.\nWin probability: ${Number(followed.winProbability || 0).toFixed(1)}%\nPaths to victory: ${Number(followed.pathsToVictory || 0).toLocaleString()}\nGames remaining: ${pendingGames}`
        : leader ? `Current leader: ${leader.name} at ${leader.wins || 0}-${leader.losses || 0}.\nPlayers entered: ${players.length}\nGames remaining: ${pendingGames}`
          : `No player cards have been submitted yet.\nGames remaining: ${pendingGames}`;
      const stopUrl = `${publicApiUrl}/?action=unsubscribe-notifications&token=${subscription.manage_token}`;
      const firstKickoff = games.map((game) => Date.parse(String(game.kickoff || ""))).filter(Number.isFinite).sort((left, right) => left - right)[0];
      const eventSummary = event === "picksDue"
        ? `${followedName}, your Week ${week.week} picks are not in yet.\n\nFirst kickoff: ${new Date(firstKickoff).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}\nSubmit before kickoff to avoid missing the opening game.`
        : event === "picksReady" ? picksReadySummary(games, week.week) : summary;
      const sent = await sendRelayEmail(env, String(subscription.destination),
        `FBP Week ${week.week}: ${notificationEventLabels[event]}`,
        `${notificationEventLabels[event]}\n\n${eventSummary}\n\nOpen FBP: ${env.PUBLIC_SITE_URL || "https://fbp26.github.io/fbp-stats/"}\n\nStop all FBP alerts: ${stopUrl}`);
      await env.DB.prepare(
        "UPDATE notification_deliveries SET status = ?, sent_at = ?, error_message = ? WHERE subscription_id = ? AND deduplication_key = ?",
      ).bind(sent ? "sent" : "failed", sent ? new Date().toISOString() : null, sent ? null : "Email relay rejected the message.", subscription.id, deduplicationKey).run();
    }
  }
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
    .prepare("SELECT id, game_index, favorite, underdog FROM games WHERE week_id = ? ORDER BY game_index")
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
  return json({
    ok: true,
    testMode: payload.mode === "test",
    submittedAt,
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
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(week.id, capturedAt, player.name, player.winProbability, player.pathsToVictory,
      scored?.winPercent || 0, gameStateJson);
  }));
  return json({ ok: true, stored: true, capturedAt }, 201, env.CORS_ORIGIN);
};

const handlePost = async (request: Request, env: Env): Promise<Response> => {
  const payload = await parsePayload(request);
  const action = cleanText(payload.action, 50);
  if (action === "log-visit") return handleAnalytics(payload, env);
  if (action === "subscribe-notifications") return subscribeNotifications(request, payload, env);
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
  if (!action) return submitCard(payload, env);
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
    await refreshActiveGameStates(env.DB);
    if (!weekBeforeRefresh) return;
    let refreshedWeek = await findWeek(env.DB, Number(weekBeforeRefresh.season), Number(weekBeforeRefresh.week), "REGULAR_SEASON");
    if (refreshedWeek?.status === "finalizing") await finalizeWeek(env.DB, refreshedWeek);
    refreshedWeek = await findWeek(env.DB, Number(weekBeforeRefresh.season), Number(weekBeforeRefresh.week), "REGULAR_SEASON");
    if (refreshedWeek) await dispatchWeekNotifications(env, refreshedWeek);
  },
} satisfies ExportedHandler<Env>;
