import assert from "node:assert/strict";
import test from "node:test";

import { atsOutcome, calculatePaths, compareStandings, scoreWeek, scoreWeekWithoutProbabilities, type PlayerCard, type ScoringGame } from "../src/scoring.ts";

const game = (overrides: Partial<ScoringGame> = {}): ScoringGame => ({
  favorite: "PIT",
  underdog: "BAL",
  spread: 3,
  status: "FINAL",
  favoriteScore: 24,
  underdogScore: 20,
  ...overrides,
});

const card = (name: string, pick: string, bestBet = ""): PlayerCard => ({
  name,
  weekName: `${name} week`,
  picks: [pick],
  bestBet,
  tiebreaker: 450,
});

test("ATS outcome subtracts the favorite spread and preserves pushes", () => {
  assert.equal(atsOutcome(game()), "favorite");
  assert.equal(atsOutcome(game({ favoriteScore: 23 })), "push");
  assert.equal(atsOutcome(game({ favoriteScore: 21 })), "underdog");
});

test("Best Bet doubles both a win and a loss while a push scores neither", () => {
  const players = scoreWeek(
    [card("Winner", "PIT", "PIT"), card("Loser", "BAL", "BAL")],
    [game()],
    460,
  );
  assert.deepEqual(players.map(({ wins, losses }) => ({ wins, losses })), [
    { wins: 2, losses: 0 },
    { wins: 0, losses: 2 },
  ]);
  const pushed = scoreWeek([card("Push", "PIT", "PIT")], [game({ favoriteScore: 23 })], 450)[0];
  assert.deepEqual({ wins: pushed.wins, losses: pushed.losses }, { wins: 0, losses: 0 });
});

test("unresolved integer spreads include push paths and split tied victories", () => {
  const result = calculatePaths(
    [card("Favorite", "PIT"), card("Underdog", "BAL")],
    [game({ status: "PREGAME", favoriteScore: null, underdogScore: null })],
  );
  assert.equal(result.outcomeCount, 3);
  assert.deepEqual(result.paths, [1.5, 1.5]);
  assert.deepEqual(result.probabilities, [50, 50]);
});

test("large outcome spaces use the deterministic bounded sample", () => {
  const games = Array.from({ length: 12 }, (_, index) => game({
    favorite: `F${index}`,
    underdog: `U${index}`,
    status: "PREGAME",
    favoriteScore: null,
    underdogScore: null,
  }));
  const players = [
    { ...card("Favorites", ""), picks: games.map((item) => item.favorite) },
    { ...card("Underdogs", ""), picks: games.map((item) => item.underdog) },
  ];
  const first = calculatePaths(players, games);
  const second = calculatePaths(players, games);
  assert.equal(first.outcomeCount, 531_441);
  assert.equal(first.evaluatedCount, 4_096);
  assert.deepEqual(first, second);
  assert.ok(Math.abs(first.probabilities.reduce((sum, value) => sum + value, 0) - 100) < 1e-9);
});

test("standings sort by wins, tiebreak distance, losses, then name", () => {
  const players = scoreWeek(
    [
      { ...card("Zulu", "PIT"), tiebreaker: 430 },
      { ...card("Alpha", "PIT"), tiebreaker: 470 },
    ],
    [game()],
    450,
  ).sort(compareStandings);
  assert.deepEqual(players.map(({ name }) => name), ["Alpha", "Zulu"]);
});

test("fast scoring preserves decisions without enumerating probabilities", () => {
  const games = [game(), game({ favorite: "BUF", underdog: "MIA", favoriteScore: 17, underdogScore: 20 })];
  const players = scoreWeekWithoutProbabilities([
    { ...card("Fast", "PIT", "PIT"), picks: ["PIT", "BUF"] },
  ], games, 460);
  assert.deepEqual(players.map(({ wins, losses, total, tiebreakDifference, winProbability, pathsToVictory }) => ({
    wins, losses, total, tiebreakDifference, winProbability, pathsToVictory,
  })), [{ wins: 2, losses: 1, total: 2, tiebreakDifference: 10, winProbability: 0, pathsToVictory: 0 }]);
});
