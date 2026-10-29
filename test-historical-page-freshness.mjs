import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const readJson = name => JSON.parse(readFileSync(path.join(root, "data", name), "utf8"));
const rows = value => Array.isArray(value) ? value : value.rows || value.data || [];
const seasonWeeks = entries => entries
  .filter(entry => String(entry.season ?? entry.Season ?? "").startsWith("2026-"))
  .map(entry => Number(entry.week ?? entry.Week))
  .filter(Number.isInteger)
  .sort((left, right) => left - right);
const unique = values => [...new Set(values)];

const archiveWeeks = readdirSync(path.join(root, "archive", "completed_regular_season"))
  .map(name => /^2026-2027_week_(\d{2})\.csv$/.exec(name))
  .filter(Boolean)
  .map(match => Number(match[1]))
  .sort((left, right) => left - right);
assert.ok(archiveWeeks.length, "No completed 2026 archive weeks are available.");
const latestWeek = archiveWeeks.at(-1);

const dashboard = rows(readJson("dashboard.json"));
const playerWeeks = rows(readJson("player_weeks.json"));
const games = rows(readJson("games.json"));
const picks = rows(readJson("player_picks.json"));
const players = rows(readJson("players.json"));
const playerSeasons = rows(readJson("player_seasons.json"));
const seasons = rows(readJson("seasons.json"));
const streaks = rows(readJson("streaks.json"));
const overall = rows(readJson("overall.json"));

for (const [page, entries] of Object.entries({
  Players: dashboard,
  "All Time": overall,
  Seasons: playerSeasons,
  Weeks: playerWeeks,
  Games: games,
  Streaks: streaks,
  Teams: picks,
  Names: players,
})) assert.ok(entries.length, `${page} feed is empty.`);

for (const [page, entries] of Object.entries({
  Players: dashboard,
  Seasons: playerWeeks,
  Weeks: playerWeeks,
  Games: games,
})) {
  assert.equal(seasonWeeks(entries).at(-1), latestWeek, `${page} does not include completed Week ${latestWeek}.`);
}

assert.ok(playerSeasons.some(entry => String(entry.season ?? entry.Season) === "2026-2027"), "Seasons feed is missing 2026-2027.");
assert.ok(seasons.some(entry => String(entry.season ?? entry.Season) === "2026-2027"), "Season selector is missing 2026-2027.");
assert.ok(picks.some(entry => String(entry.gameId || "").startsWith(`2026-2027|${latestWeek}|`)), `Teams and Games pick feed is missing completed Week ${latestWeek}.`);
assert.equal(unique(games.filter(entry => String(entry.season) === "2026-2027" && Number(entry.week) === latestWeek).map(entry => entry.gameId)).length,
  games.filter(entry => String(entry.season) === "2026-2027" && Number(entry.week) === latestWeek).length,
  `Games feed has duplicate Week ${latestWeek} game rows.`);

console.log(`Historical page feeds are current through 2026 Week ${latestWeek}.`);
