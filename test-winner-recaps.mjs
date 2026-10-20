import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = file => readFile(new URL(file, import.meta.url), "utf8").then(JSON.parse);
const index = await readJson("./data/winner-recaps/index.json");

assert.equal(index.weeks.length, 6, "The current season should publish six completed winner pages.");

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

console.log(`Validated ${index.weeks.length} winner pages and ${index.weeks.reduce((total, week) => total + week.raceFrames, 0)} preserved race frames.`);
