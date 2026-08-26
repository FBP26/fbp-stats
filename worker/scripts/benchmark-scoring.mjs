import { performance } from "node:perf_hooks";

import { scoreWeek, scoreWeekWithoutProbabilities } from "../src/scoring.ts";

const source = new URL(process.env.FBP_BENCHMARK_API || "https://script.google.com/macros/s/AKfycbxZUgJm6LstCEomhmrlJYa_nH7tsmxC_4UZwYdroIZbs-PeI6KdPqUZtsF9fZvr_YuNWQ/exec");
source.searchParams.set("action", "preseason-test");
source.searchParams.set("season", "2026");
source.searchParams.set("week", "4");

const payload = await fetch(source).then((response) => response.json());
if (!Array.isArray(payload.players) || !Array.isArray(payload.games)) {
  throw new Error(payload.error || "Benchmark API did not return players and games.");
}

const cards = payload.players
  .filter((player) => {
    const tiebreaker = Number(player.tiebreaker);
    return Number.isFinite(tiebreaker) && tiebreaker >= -100 && tiebreaker <= 1200;
  })
  .map((player) => ({
    name: player.name,
    weekName: player.weekName,
    picks: player.picks,
    bestBet: player.bestBet,
    tiebreaker: Number(player.tiebreaker),
  }));
const games = payload.games.map((game) => ({
  favorite: game.favorite,
  underdog: game.underdog,
  spread: Number(game.spread),
  status: "PREGAME",
  favoriteScore: null,
  underdogScore: null,
}));

const measure = (callback) => {
  for (let index = 0; index < 3; index += 1) callback();
  const runs = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    callback();
    runs.push(performance.now() - startedAt);
  }
  runs.sort((left, right) => left - right);
  return {
    minimumMs: runs[0],
    medianMs: runs[Math.floor(runs.length / 2)],
    p95Ms: runs[Math.floor(runs.length * 0.95) - 1],
    maximumMs: runs.at(-1),
  };
};

console.log(JSON.stringify({
  players: cards.length,
  games: games.length,
  probabilityScoring: measure(() => scoreWeek(cards, games, null)),
  deterministicScoring: measure(() => scoreWeekWithoutProbabilities(cards, games, null)),
}, null, 2));