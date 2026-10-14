import assert from "node:assert/strict";
import test from "node:test";

import { buildRaceGameState, validateRaceSnapshotPlayers } from "../src/race.ts";

test("race snapshots accept one complete normalized current field", () => {
  assert.deepEqual(validateRaceSnapshotPlayers([
    { name: "Alpha", winProbability: 62.5, pathsToVictory: 5 },
    { name: "Beta", winProbability: 37.5, pathsToVictory: 3 },
  ], ["Alpha", "Beta"]), [
    { name: "Alpha", winProbability: 62.5, pathsToVictory: 5 },
    { name: "Beta", winProbability: 37.5, pathsToVictory: 3 },
  ]);
});

test("race snapshots reject incomplete, duplicate, and unknown players", () => {
  assert.throws(() => validateRaceSnapshotPlayers([
    { name: "Alpha", winProbability: 100, pathsToVictory: 1 },
  ], ["Alpha", "Beta"]), /every current player/);
  assert.throws(() => validateRaceSnapshotPlayers([
    { name: "Alpha", winProbability: 50, pathsToVictory: 1 },
    { name: "Alpha", winProbability: 50, pathsToVictory: 1 },
  ], ["Alpha", "Beta"]), /current field/);
  assert.throws(() => validateRaceSnapshotPlayers([
    { name: "Alpha", winProbability: 50, pathsToVictory: 1 },
    { name: "Gamma", winProbability: 50, pathsToVictory: 1 },
  ], ["Alpha", "Beta"]), /current field/);
});

test("race snapshots reject invalid probabilities and path counts", () => {
  assert.throws(() => validateRaceSnapshotPlayers([
    { name: "Alpha", winProbability: 60, pathsToVictory: 1 },
    { name: "Beta", winProbability: 30, pathsToVictory: 1 },
  ], ["Alpha", "Beta"]), /total 100/);
  assert.throws(() => validateRaceSnapshotPlayers([
    { name: "Alpha", winProbability: Number.NaN, pathsToVictory: 1 },
    { name: "Beta", winProbability: 100, pathsToVictory: 1 },
  ], ["Alpha", "Beta"]), /finite values/);
  assert.throws(() => validateRaceSnapshotPlayers([
    { name: "Alpha", winProbability: 50, pathsToVictory: 1.5 },
    { name: "Beta", winProbability: 50, pathsToVictory: 1 },
  ], ["Alpha", "Beta"]), /non-negative integers/);
});
test("race game state carries the final game combined net passing yards", () => {
  const state = buildRaceGameState([
    { gameId: "1", away: "NYJ", home: "BUF", awayScore: 10, homeScore: 17, state: "FINAL", netPassingYards: null },
    { gameId: "2", away: "PHI", home: "JAX", awayScore: 17, homeScore: 19, state: "FINAL", netPassingYards: 579 },
  ]);
  assert.equal(state[0].combinedNetPassingYards, undefined);
  assert.equal(state[1].combinedNetPassingYards, 579);
  assert.equal(state[1].away, "PHI");
  assert.equal(state[1].status, "FINAL");
});

test("race game state omits combined net passing yards before the final game produces them", () => {
  const [pregame] = buildRaceGameState([
    { gameId: "3", awayTeam: "BAL", homeTeam: "ATL", state: "PREGAME", netPassingYards: 0 },
  ]);
  assert.equal(pregame.combinedNetPassingYards, undefined);
  assert.equal(pregame.away, "BAL");
  assert.equal(pregame.awayScore, "");
});
