import assert from "node:assert/strict";
import test from "node:test";

import { isRefreshWindow, parseEspnGame, type StoredGame } from "../src/espn.ts";

const game: StoredGame = {
  id: 1,
  externalId: "nfl.g.20260827002",
  favorite: "BUF",
  underdog: "pit",
  homeTeam: "BUF",
  awayTeam: "pit",
  metadata: { espnEventId: "401873298" },
};

const payload = (state: string, completed: boolean, homeScore: string, awayScore: string) => ({
  gamepackageJSON: {
    header: {
      competitions: [{
        status: { period: 4, displayClock: "0:00", type: { state, completed, shortDetail: completed ? "Final" : "4th 0:30" } },
        competitors: [
          { homeAway: "home", score: homeScore, possession: true, team: { abbreviation: "BUF" } },
          { homeAway: "away", score: awayScore, possession: false, team: { abbreviation: "PIT" } },
        ],
      }],
    },
    boxscore: {
      teams: [
        { team: { abbreviation: "PIT" }, statistics: [{ name: "netPassingYards", value: 201 }] },
        { team: { abbreviation: "BUF" }, statistics: [{ name: "netPassingYards", displayValue: "249" }] },
      ],
    },
  },
});

test("parseEspnGame maps live scores, possession, and net passing yards", () => {
  assert.deepEqual(parseEspnGame(payload("in", false, "24", "20"), game), {
    state: "LIVE",
    status: "IN_PROGRESS",
    statusText: "4th 0:30",
    favoriteScore: 24,
    underdogScore: 20,
    homeScore: 24,
    awayScore: 20,
    period: "4",
    clock: "0:00",
    possession: "BUF",
    combinedNetPassingYards: 450,
  });
});

test("parseEspnGame maps final state and rejects mismatched teams", () => {
  assert.equal(parseEspnGame(payload("post", true, "27", "20"), game).state, "FINAL");
  assert.throws(() => parseEspnGame(payload("post", true, "27", "20"), { ...game, homeTeam: "MIA" }), /do not match/);
});

test("isRefreshWindow bounds scheduled polling around encoded game dates", () => {
  assert.equal(isRefreshWindow([game], new Date("2026-08-26T12:00:00Z")), true);
  assert.equal(isRefreshWindow([game], new Date("2026-08-20T12:00:00Z")), false);
  assert.equal(isRefreshWindow([game], new Date("2026-08-30T12:00:00Z")), false);
});