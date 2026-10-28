import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const targetWeeks = [2, 3];
const number = value => Number(value || 0);

function gameStatus(value) {
  const status = String(value || "").toUpperCase();
  if (["FINAL", "STATUS_FINAL", "COMPLETED"].includes(status)) return "FINAL";
  if (["", "PRE", "PREGAME", "SCHEDULED", "STATUS_SCHEDULED"].includes(status)) return "PREGAME";
  return "LIVE";
}

function atsWinner(game) {
  const margin = game.favoriteScore - game.underdogScore - game.spread;
  return margin === 0 ? null : margin > 0 ? game.favorite : game.underdog;
}

function greatestCommonDivisor(left, right) {
  return right ? greatestCommonDivisor(right, left % right) : left;
}

function scenarioIndexes(total) {
  if (total <= 250_000) return Array.from({ length: total }, (_, index) => index);
  const count = Math.min(total, 4_096);
  let step = Math.max(1, Math.floor(total * 0.618033988749895));
  while (greatestCommonDivisor(step, total) !== 1) step += 1;
  const offset = Math.floor(total * 0.381966011250105);
  return Array.from({ length: count }, (_, index) => (offset + index * step) % total);
}

function rebuildFramePlayers(recap, snapshot) {
  const gameState = new Map((snapshot.gameState || []).map(game => [[game.away, game.home].join("|"), game]));
  const games = recap.games.map(game => {
    const state = gameState.get([game.away, game.home].join("|")) || {};
    return {
      ...game,
      status: gameStatus(state.status || state.state),
      favoriteScore: game.favorite === game.home ? number(state.homeScore) : number(state.awayScore),
      underdogScore: game.underdog === game.home ? number(state.homeScore) : number(state.awayScore),
    };
  });
  const finalScore = player => games.reduce((total, game, index) => {
    if (game.status !== "FINAL") return total;
    const winner = atsWinner(game);
    return winner === player.picks[index] ? total + (player.bestBet === winner ? 2 : 1) : total;
  }, 0);
  const currentRecord = player => games.reduce((record, game, index) => {
    if (game.status === "PREGAME") return record;
    const winner = atsWinner(game);
    if (!winner) return record;
    const points = player.bestBet === player.picks[index] ? 2 : 1;
    if (winner === player.picks[index]) record.wins += points;
    else record.losses += points;
    return record;
  }, { wins: 0, losses: 0 });
  const unresolved = games
    .map((game, index) => ({
      game,
      index,
      outcomes: Number.isInteger(game.spread) ? ["underdog", "favorite", "push"] : ["underdog", "favorite"],
    }))
    .filter(({ game }) => game.status !== "FINAL");
  const outcomeCount = unresolved.reduce((total, item) => total * item.outcomes.length, 1);
  const paths = recap.players.map(() => 0);
  const finalWins = recap.players.map(finalScore);
  const indexes = scenarioIndexes(outcomeCount);

  indexes.forEach(pathIndex => {
    let remaining = pathIndex;
    const projectedWins = finalWins.slice();
    unresolved.forEach(({ game, index, outcomes }) => {
      const outcome = outcomes[remaining % outcomes.length];
      remaining = Math.floor(remaining / outcomes.length);
      const winner = outcome === "favorite" ? game.favorite : outcome === "underdog" ? game.underdog : null;
      if (!winner) return;
      recap.players.forEach((player, playerIndex) => {
        if (player.picks[index] === winner) projectedWins[playerIndex] += player.bestBet === winner ? 2 : 1;
      });
    });
    const highest = Math.max(...projectedWins);
    const leaders = projectedWins.map((wins, index) => wins === highest ? index : -1).filter(index => index >= 0);
    leaders.forEach(index => { paths[index] += 1 / leaders.length; });
  });

  return recap.players.map((player, index) => {
    const record = currentRecord(player);
    const decisions = record.wins + record.losses;
    return {
      name: player.name,
      wins: record.wins,
      losses: record.losses,
      tiebreakerDiff: player.tiebreakerDiff,
      winProbability: paths[index] / indexes.length * 100,
      pathsToVictory: paths[index],
      winPercent: decisions ? record.wins / decisions : 0,
    };
  });
}

for (const week of targetWeeks) {
  const file = path.join(root, "data", "winner-recaps", `2026-2027_week_${String(week).padStart(2, "0")}.json`);
  const recap = JSON.parse(await readFile(file, "utf8"));
  recap.raceSnapshots = recap.raceSnapshots.map(snapshot => ({ ...snapshot, players: rebuildFramePlayers(recap, snapshot) }));
  const finalFrame = recap.raceSnapshots.at(-1);
  const finalLeader = [...finalFrame.players].sort((left, right) =>
    right.winProbability - left.winProbability
    || right.wins - left.wins
    || left.tiebreakerDiff - right.tiebreakerDiff
    || left.name.localeCompare(right.name)
  )[0];
  assert.equal(finalLeader.name, recap.winners[0].name, `Week ${week} reconstructed final leader must match the winner.`);
  await writeFile(file, `${JSON.stringify(recap)}\n`);
  console.log(`Rebuilt Week ${week}: ${recap.raceSnapshots.length} frames; final leader ${finalLeader.name}.`);
}
