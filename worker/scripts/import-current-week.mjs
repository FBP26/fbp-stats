import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SOURCE_API = "https://script.google.com/macros/s/AKfycbxZUgJm6LstCEomhmrlJYa_nH7tsmxC_4UZwYdroIZbs-PeI6KdPqUZtsF9fZvr_YuNWQ/exec";
const DEFAULT_OUTPUT = ".generated/current-week.sql";

const sqlText = (value) => `'${String(value ?? "").replaceAll("'", "''")}'`;

const requiredNumber = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be numeric.`);
  return number;
};

const optionalNumber = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const sqlNumber = (value) => value === null ? "NULL" : String(value);

const gameState = (game) => {
  const status = String(game.espnStatus || game.status || "").toUpperCase();
  if (["POST", "FINAL", "COMPLETED"].includes(status)) return "FINAL";
  if (["IN", "LIVE", "IN_PROGRESS"].includes(status)) return "LIVE";
  return "PREGAME";
};

const teamScore = (game, team) => {
  const home = String(game.home || game.homeTeam?.abbreviation || "");
  const isHome = String(team) === home;
  return optionalNumber(isHome ? game.espnHomeScore ?? game.homeScore : game.espnAwayScore ?? game.awayScore);
};

const importedTimestamp = (base, index) => {
  const parsed = Date.parse(base);
  if (!Number.isFinite(parsed)) throw new Error("current-week updatedAt must be an ISO timestamp.");
  return new Date(parsed + index).toISOString();
};

const validatePayloads = (active, current) => {
  if (!active?.ok) throw new Error(active?.error || "active-week did not return ok=true.");
  if (!active.staged || !Array.isArray(active.games) || active.games.length === 0) {
    throw new Error(`No ${active.phase || "regular-season"} week is staged; refusing to import stale Sheet rows.`);
  }
  if (!current?.ok) throw new Error(current?.error || "current-week did not return ok=true.");
  if (Number(current.season) !== Number(active.season) || Number(current.week) !== Number(active.week)) {
    throw new Error("active-week and current-week identify different weeks.");
  }
  if (!Array.isArray(current.players) || !Array.isArray(current.raceSnapshots)) {
    throw new Error("current-week players and raceSnapshots must be arrays.");
  }
};

export const buildImportSql = (active, current) => {
  validatePayloads(active, current);
  const season = requiredNumber(active.season, "season");
  const week = requiredNumber(active.week, "week");
  const phase = String(active.phase || "REGULAR_SEASON");
  const weekWhere = `season = ${season} AND week = ${week} AND phase = ${sqlText(phase)}`;
  const states = active.games.map(gameState);
  const status = states.includes("LIVE") ? "live" : "staged";
  const actualTiebreaker = optionalNumber(current.actualTiebreaker);
  const capturedAt = String(current.updatedAt || "");
  importedTimestamp(capturedAt, 0);

  const lines = [
    "PRAGMA foreign_keys = ON;",
    "-- Generated from Apps Script. Review this file before remote execution.",
    `UPDATE weeks SET status = 'finalized', finalized_at = COALESCE(finalized_at, CURRENT_TIMESTAMP) WHERE phase = ${sqlText(phase)} AND status IN ('staged', 'open', 'live', 'finalizing') AND NOT (${weekWhere});`,
    `INSERT INTO weeks (season, week, phase, status, tiebreak_actual) VALUES (${season}, ${week}, ${sqlText(phase)}, ${sqlText(status)}, ${sqlNumber(actualTiebreaker)}) ON CONFLICT (season, week, phase) DO UPDATE SET status = excluded.status, tiebreak_actual = excluded.tiebreak_actual, finalized_at = NULL;`,
    `DELETE FROM submission_corrections WHERE submission_id IN (SELECT id FROM submissions WHERE week_id = (SELECT id FROM weeks WHERE ${weekWhere}));`,
    `DELETE FROM submission_picks WHERE submission_id IN (SELECT id FROM submissions WHERE week_id = (SELECT id FROM weeks WHERE ${weekWhere}));`,
    `DELETE FROM submissions WHERE week_id = (SELECT id FROM weeks WHERE ${weekWhere});`,
    `DELETE FROM live_snapshots WHERE week_id = (SELECT id FROM weeks WHERE ${weekWhere});`,
    `DELETE FROM race_snapshots WHERE week_id = (SELECT id FROM weeks WHERE ${weekWhere});`,
    `DELETE FROM game_states WHERE game_id IN (SELECT id FROM games WHERE week_id = (SELECT id FROM weeks WHERE ${weekWhere}));`,
    `DELETE FROM games WHERE week_id = (SELECT id FROM weeks WHERE ${weekWhere});`,
  ];

  active.games.forEach((game, index) => {
    const externalId = String(game.gameId || game.externalId || "").trim();
    const favorite = String(game.favorite || "").trim();
    const underdog = String(game.underdog || "").trim();
    const home = String(game.home || game.homeTeam?.abbreviation || "").trim();
    const away = String(game.away || game.awayTeam?.abbreviation || "").trim();
    if (!externalId || !favorite || !underdog || !home || !away) {
      throw new Error(`Game ${index + 1} is missing an ID or team abbreviation.`);
    }
    const spread = requiredNumber(game.spread, `Game ${index + 1} spread`);
    lines.push(
      `INSERT INTO games (week_id, game_index, external_id, kickoff_at, favorite, underdog, spread, home_team, away_team, metadata_json) VALUES ((SELECT id FROM weeks WHERE ${weekWhere}), ${index}, ${sqlText(externalId)}, ${sqlText(game.kickoff)}, ${sqlText(favorite)}, ${sqlText(underdog)}, ${spread}, ${sqlText(home)}, ${sqlText(away)}, ${sqlText(JSON.stringify(game))});`,
      `INSERT INTO game_states (game_id, state, favorite_score, underdog_score, period, clock, net_passing_yards, source_updated_at) VALUES ((SELECT id FROM games WHERE week_id = (SELECT id FROM weeks WHERE ${weekWhere}) AND game_index = ${index}), ${sqlText(states[index])}, ${sqlNumber(teamScore(game, favorite))}, ${sqlNumber(teamScore(game, underdog))}, ${sqlText(game.period)}, ${sqlText(game.clock)}, ${sqlNumber(optionalNumber(game.combinedNetPassingYards))}, ${sqlText(capturedAt)});`,
    );
  });

  current.players.forEach((player, playerIndex) => {
    const name = String(player.name || "").trim();
    const picks = Array.isArray(player.picks) ? player.picks.slice(0, active.games.length).map(pick => String(pick || "").trim()) : [];
    const bestBetIndex = picks.indexOf(String(player.bestBet || "").trim());
    const tiebreaker = requiredNumber(player.tiebreaker, `${name || `Player ${playerIndex + 1}`} tiebreaker`);
    if (!name || picks.length !== active.games.length || picks.some(pick => !pick) || bestBetIndex < 0) {
      throw new Error(`Player ${name || playerIndex + 1} does not have a complete valid card.`);
    }
    if (tiebreaker < -100 || tiebreaker > 1200) {
      throw new Error(`${name} has an out-of-range tiebreaker: ${player.tiebreaker}.`);
    }
    const submittedAt = importedTimestamp(capturedAt, playerIndex);
    lines.push(
      `INSERT INTO players (canonical_name) VALUES (${sqlText(name)}) ON CONFLICT (canonical_name) DO NOTHING;`,
      `INSERT INTO submissions (week_id, player_id, submitted_name, week_name, best_bet_game_index, tiebreaker, source, submitted_at) VALUES ((SELECT id FROM weeks WHERE ${weekWhere}), (SELECT id FROM players WHERE canonical_name = ${sqlText(name)} COLLATE NOCASE), ${sqlText(name)}, ${sqlText(player.weekName)}, ${bestBetIndex}, ${tiebreaker}, 'apps-script-import', ${sqlText(submittedAt)});`,
    );
    picks.forEach((pick, gameIndex) => lines.push(
      `INSERT INTO submission_picks (submission_id, game_id, picked_team) VALUES ((SELECT id FROM submissions WHERE week_id = (SELECT id FROM weeks WHERE ${weekWhere}) AND player_id = (SELECT id FROM players WHERE canonical_name = ${sqlText(name)} COLLATE NOCASE) AND superseded_at IS NULL), (SELECT id FROM games WHERE week_id = (SELECT id FROM weeks WHERE ${weekWhere}) AND game_index = ${gameIndex}), ${sqlText(pick)});`,
    ));
  });

  current.raceSnapshots.forEach((frame) => {
    const timestamp = String(frame.timestamp || "");
    importedTimestamp(timestamp, 0);
    const framePlayers = Array.isArray(frame.players) ? frame.players : [];
    framePlayers.forEach((player) => lines.push(
      `INSERT INTO race_snapshots (week_id, captured_at, player_name, win_probability, paths, win_pct, game_state_json) VALUES ((SELECT id FROM weeks WHERE ${weekWhere}), ${sqlText(timestamp)}, ${sqlText(player.name)}, ${requiredNumber(player.winProbability || 0, "race winProbability")}, ${requiredNumber(player.pathsToVictory || 0, "race pathsToVictory")}, ${requiredNumber(player.winPercent || 0, "race winPercent")}, ${sqlText(JSON.stringify(frame.gameState || []))});`,
    ));
  });

  lines.push(
    `INSERT INTO live_snapshots (week_id, captured_at, payload_json) VALUES ((SELECT id FROM weeks WHERE ${weekWhere}), ${sqlText(capturedAt)}, ${sqlText(JSON.stringify(current))});`,
  );
  return `${lines.join("\n")}\n`;
};

const fetchAction = async (source, action, parameters = {}) => {
  const url = new URL(source);
  url.searchParams.set("action", action);
  Object.entries(parameters).forEach(([name, value]) => url.searchParams.set(name, String(value)));
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${action} returned HTTP ${response.status}.`);
  return response.json();
};

const optionValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const main = async () => {
  const source = optionValue("--source", process.env.FBP_SOURCE_API || DEFAULT_SOURCE_API);
  const output = path.resolve(optionValue("--output", DEFAULT_OUTPUT));
  const phase = String(optionValue("--phase", "REGULAR_SEASON")).toUpperCase();
  let active;
  let current;
  if (phase === "PRESEASON") {
    const season = requiredNumber(optionValue("--season", ""), "--season");
    const week = requiredNumber(optionValue("--week", ""), "--week");
    [active, current] = await Promise.all([
      fetchAction(source, "week-config", { season, week, phase }),
      fetchAction(source, "preseason-test", { season, week }),
    ]);
    active.staged = Array.isArray(active.games) && active.games.length > 0;
    current.updatedAt = new Date().toISOString();
    current.raceSnapshots = current.raceSnapshots || [];
    if (process.argv.includes("--skip-invalid-test-cards")) {
      const importedPlayers = current.players.filter((player) => {
        const tiebreaker = Number(player.tiebreaker);
        return Number.isFinite(tiebreaker) && tiebreaker >= -100 && tiebreaker <= 1200;
      });
      const skipped = current.players.length - importedPlayers.length;
      current = { ...current, players: importedPlayers };
      if (skipped) console.warn(`Skipped ${skipped} preseason test card(s) with out-of-range tiebreakers.`);
    }
  } else if (phase === "REGULAR_SEASON") {
    if (process.argv.includes("--skip-invalid-test-cards")) {
      throw new Error("--skip-invalid-test-cards is allowed only with --phase PRESEASON.");
    }
    [active, current] = await Promise.all([
      fetchAction(source, "active-week"),
      fetchAction(source, "current-week"),
    ]);
  } else {
    throw new Error("--phase must be REGULAR_SEASON or PRESEASON.");
  }
  const sql = buildImportSql(active, current);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, sql, "utf8");
  console.log(`Prepared ${active.season}-${Number(active.season) + 1} Week ${active.week}: ${active.games.length} games, ${current.players.length} players, ${current.raceSnapshots.length} race frames.`);
  console.log(`Review before execution: ${output}`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}