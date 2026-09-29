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

test("Best Bet doubles a win or loss and a pushed Best Bet counts one loss", () => {
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
  assert.deepEqual({ wins: pushed.wins, losses: pushed.losses }, { wins: 0, losses: 1 });
  assert.equal(pushed.winPercent, 0);
  for (const status of ["LIVE", "FINAL"] as const) {
    const ordinaryPush = scoreWeekWithoutProbabilities([card("Ordinary push", "PIT")], [game({ status, favoriteScore: 23 })], null)[0];
    assert.deepEqual({ wins: ordinaryPush.wins, losses: ordinaryPush.losses }, { wins: 0, losses: 0 });
  }
  const pending = scoreWeekWithoutProbabilities([card("Pending", "PIT", "PIT")], [game({ status: "PREGAME", favoriteScore: 23 })], null)[0];
  assert.deepEqual({ wins: pending.wins, losses: pending.losses }, { wins: 0, losses: 0 });
});

test('an opposing Best Bet earns its own win or loss and one loss on a push', () => {
  for (const favoriteScore of [24, 21]) {
    for (const status of ['LIVE', 'FINAL'] as const) {
      const result = scoreWeekWithoutProbabilities([card('Opposing', 'PIT', 'BAL')], [game({ favoriteScore, status })], null)[0];
      assert.deepEqual({ wins: result.wins, losses: result.losses }, { wins: 1, losses: 1 });
    }
  }
  const push = scoreWeekWithoutProbabilities([card('Opposing', 'PIT', 'BAL')], [game({ favoriteScore: 23 })], null)[0];
  assert.deepEqual({ wins: push.wins, losses: push.losses }, { wins: 0, losses: 1 });
  const pending = scoreWeekWithoutProbabilities([card('Opposing', 'PIT', 'BAL')], [game({ status: 'PREGAME' })], null)[0];
  assert.equal(pending.wins + pending.losses, 0);
  assert.deepEqual(calculatePaths([card('Opposing', 'PIT', 'BAL'), card('Favorite', 'PIT', 'PIT'), card('Underdog', 'BAL', 'BAL')], [game({ status: 'PREGAME', spread: 3.5 })]).probabilities, [0, 50, 50]);
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

test('optimized paths match direct scenario scoring for mixed finals, pushes and a full 31-player field', () => {
  for (const gameCount of [1, 4, 7]) {
    const games = Array.from({ length: gameCount }, (_, index) => game({
      favorite: `F${index}`, underdog: `U${index}`, spread: index % 2 ? 3.5 : 3,
      status: index === 1 ? 'FINAL' : 'PREGAME',
      favoriteScore: index === 1 ? 20 : null, underdogScore: index === 1 ? 17 : null,
    }));
    const players = Array.from({ length: 31 }, (_, index) => ({ ...card(`Player${index}`, ''),
      picks: games.map((match, position) => (index >> (position % 5)) & 1 ? match.favorite : match.underdog),
      bestBet: index % 3 ? games[index % gameCount].favorite : '',
    }));
    const unresolved = games.map((match, position) => ({ match, position })).filter(({ match }) => match.status !== 'FINAL');
    const total = unresolved.reduce((count, { match }) => count * (Number.isInteger(match.spread) ? 3 : 2), 1);
    const paths = players.map(() => 0);
    for (let scenario = 0; scenario < total; scenario += 1) {
      let encoded = scenario;
      const resolved = games.map(match => ({ ...match }));
      for (const { match, position } of unresolved) {
        const radix = Number.isInteger(match.spread) ? 3 : 2;
        const outcome = encoded % radix;
        encoded = Math.floor(encoded / radix);
        resolved[position] = { ...match, status: 'FINAL', underdogScore: 10, favoriteScore: outcome === 2 ? 10 + match.spread : outcome === 1 ? 20 : 0 };
      }
      const scores = scoreWeekWithoutProbabilities(players, resolved, null).map(player => player.wins);
      const max = Math.max(...scores);
      const winners = scores.map((score, position) => score === max ? position : -1).filter(position => position >= 0);
      for (const winner of winners) paths[winner] += 1 / winners.length;
    }
    const result = calculatePaths(players, games);
    assert.deepEqual(result.paths, paths);
    assert.equal(result.evaluatedCount, total);
  }
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
