import assert from "node:assert/strict";
import test from "node:test";

import { validateRaceSnapshotPlayers } from "../src/race.ts";

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