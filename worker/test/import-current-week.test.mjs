import assert from "node:assert/strict";
import test from "node:test";

import { buildImportSql } from "../scripts/import-current-week.mjs";

const game = {
  gameId: "2026091001",
  kickoff: "2026-09-10T20:20:00-04:00",
  away: "DAL",
  home: "PHI",
  favorite: "PHI",
  spread: 3.5,
  underdog: "DAL",
  status: "PREGAME",
  homeScore: "",
  awayScore: "",
};

const active = {
  ok: true,
  staged: true,
  season: 2026,
  week: 1,
  phase: "REGULAR_SEASON",
  games: [game],
};

const current = {
  ok: true,
  season: 2026,
  seasonLabel: "2026-2027",
  week: 1,
  updatedAt: "2026-09-09T12:00:00.000Z",
  favorites: ["PHI"],
  favoriteScores: [""],
  spreads: [3.5],
  underdogScores: [""],
  underdogs: ["DAL"],
  actualTiebreaker: "",
  tiebreakStatus: "",
  games: [game],
  players: [{ name: "O'Brien", weekName: "Bird week", picks: ["PHI"], bestBet: "PHI", tiebreaker: 455 }],
  raceSnapshots: [{ timestamp: "2026-09-10T12:00:00.000Z", gameState: [], players: [{ name: "O'Brien", winProbability: 50, pathsToVictory: 1, winPercent: 0 }] }],
};

test("buildImportSql creates a complete rerunnable week import", () => {
  const sql = buildImportSql(active, current);
  assert.match(sql, /INSERT INTO weeks/);
  assert.match(sql, /INSERT INTO games/);
  assert.match(sql, /INSERT INTO submissions/);
  assert.match(sql, /INSERT INTO submission_picks/);
  assert.match(sql, /INSERT INTO race_snapshots/);
  assert.match(sql, /INSERT INTO live_snapshots/);
  assert.match(sql, /O''Brien/);
  assert.match(sql, /apps-script-import/);
});

test("buildImportSql refuses stale current-week rows when no week is staged", () => {
  assert.throws(
    () => buildImportSql({ ...active, staged: false, games: [] }, current),
    /refusing to import stale Sheet rows/,
  );
});

test("buildImportSql accepts an explicitly staged preseason week", () => {
  const sql = buildImportSql(
    { ...active, phase: "PRESEASON" },
    { ...current, testMode: true, raceSnapshots: [] },
  );
  assert.match(sql, /phase = 'PRESEASON'/);
  assert.match(sql, /VALUES \(2026, 1, 'PRESEASON'/);
});

test("buildImportSql refuses incomplete player cards", () => {
  const invalid = { ...current, players: [{ ...current.players[0], picks: [] }] };
  assert.throws(() => buildImportSql(active, invalid), /complete valid card/);
});

test("buildImportSql rejects out-of-range tiebreakers before D1 execution", () => {
  const invalid = { ...current, players: [{ ...current.players[0], tiebreaker: 65467 }] };
  assert.throws(() => buildImportSql(active, invalid), /out-of-range tiebreaker/);
});