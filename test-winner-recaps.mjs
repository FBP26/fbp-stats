import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = file => readFile(new URL(file, import.meta.url), "utf8").then(JSON.parse);
const index = await readJson("./data/winner-recaps/index.json");
const probabilityLeader = frame => [...frame.players].sort((left, right) =>
  Number(right.winProbability || 0) - Number(left.winProbability || 0)
  || Number(right.wins || 0) - Number(left.wins || 0)
  || Number(left.tiebreakerDiff || 0) - Number(right.tiebreakerDiff || 0)
  || left.name.localeCompare(right.name)
)[0];
const isFinal = game => ["FINAL", "STATUS_FINAL", "COMPLETED"].includes(String(game.status || game.state || "").toUpperCase());

assert.equal(index.weeks.length, 7, "The current season should publish seven completed winner pages.");

for (const week of index.weeks) {
  const data = await readJson(`./data/winner-recaps/${week.file}`);
  assert.equal(data.season, week.season);
  assert.equal(data.week, week.week);
  assert.ok(data.winners.length, `Week ${week.week} must have a winner.`);
  assert.ok(data.players.length >= data.winners.length, `Week ${week.week} must include the field.`);
  assert.ok(data.games.length, `Week ${week.week} must include the finalized slate.`);
  assert.equal(data.games.length, data.players[0].picks.length, `Week ${week.week} games must match the finalized pick count.`);
  assert.ok(data.raceSnapshots.length, `Week ${week.week} must preserve race frames.`);
  const winner = data.winners[0];
  let priorTimestamp = -Infinity;
  for (const frame of data.raceSnapshots) {
    const timestamp = Date.parse(frame.timestamp);
    assert.ok(Number.isFinite(timestamp) && timestamp >= priorTimestamp, `Week ${week.week} race frames must be chronological.`);
    priorTimestamp = timestamp;
    assert.equal(new Set(frame.players.map(player => player.name)).size, frame.players.length, `Week ${week.week} race frames cannot duplicate players.`);
    assert.ok(frame.players.every(player => Number.isFinite(Number(player.winProbability)) && Number(player.winProbability) >= 0), `Week ${week.week} race probabilities must be non-negative numbers.`);
    const probabilityTotal = frame.players.reduce((total, player) => total + Number(player.winProbability), 0);
    assert.ok(probabilityTotal > 0 && probabilityTotal <= 100.01, `Week ${week.week} race probabilities must be bounded.`);
  }
  const finalFrame = data.raceSnapshots.at(-1);
  if ((finalFrame.gameState || []).length && finalFrame.gameState.every(isFinal)) {
    assert.equal(probabilityLeader(finalFrame).name, winner.name, `Week ${week.week} all-final race frame must lead with the finalized winner.`);
  }
  const helped = winner.highlights.helped;
  assert.equal(new Set(helped.map(row => row.rank)).size, data.games.length, `Week ${week.week} Helped ranks must be unique.`);
  assert.ok(helped.filter(row => row.result === "Loss").every(row => row.percent <= 0), `Week ${week.week} losses cannot have positive Helped.`);
  assert.ok(data.raceSnapshots.some(frame => frame.players.some(player => player.name === winner.name)), `Week ${week.week} race must include its winner.`);
}

const barb = await readJson("./data/winner-recaps/2026-2027_week_05.json");
assert.equal(barb.winners[0].name, "Barb");
assert.equal(barb.winners[0].wins, 12);
assert.equal(barb.winners[0].losses, 4);
assert.equal(barb.winners[0].career.weeklyWins, 9);
assert.equal(barb.winners[0].career.playoffWins, 1);
assert.equal(barb.winners[0].career.seasonChampionships, 0);
assert.equal(barb.winners[0].highlights.correctPicks, 11);
assert.equal(barb.raceSnapshots.length, 255);

const buster = await readJson("./data/winner-recaps/2026-2027_week_07.json");
assert.equal(buster.winners[0].name, "Buster");
assert.equal(buster.winners[0].actualTiebreaker, 412);
assert.equal(buster.winners[0].wins, 10);
assert.equal(buster.raceSnapshots.length, 147);
const dallasCoverFrame = buster.raceSnapshots.find(frame => {
  const dallas = frame.gameState.find(game => game.away === "DAL" && game.home === "PHI");
  const busterPlayer = frame.players.find(player => player.name === "Buster");
  return dallas && Number(dallas.awayScore) > Number(dallas.homeScore) && Number(busterPlayer?.winProbability) > 50;
});
assert.ok(dallasCoverFrame, "Week 7 must preserve Buster's Dallas-cover probability lead.");
assert.equal(probabilityLeader(dallasCoverFrame).name, "Buster", "Buster must lead the Dallas-cover frame by win probability.");

console.log(`Validated ${index.weeks.length} winner pages and ${index.weeks.reduce((total, week) => total + week.raceFrames, 0)} preserved race frames.`);
