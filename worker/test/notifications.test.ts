import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultNotificationPreferences,
  leaderPushSummary,
  maskNotificationDestination,
  normalizeNotificationDestination,
  parseNotificationPreferences,
  picksDueReminderIsEligible,
  scheduledNotificationEvents,
  seasonRankMovementSummary,
} from "../src/notifications.ts";

test("notification preferences use conservative defaults and accept explicit booleans", () => {
  assert.deepEqual(parseNotificationPreferences({ firstPlace: true, picksReady: false, beforeMnf: "yes" }), {
    ...defaultNotificationPreferences(),
    picksReady: false,
    firstPlace: true,
  });
});

test("email destinations are normalized, validated, and masked", () => {
  assert.equal(normalizeNotificationDestination("email", " Player@Example.COM "), "player@example.com");
  assert.equal(maskNotificationDestination("email", "player@example.com"), "p*****@example.com");
  assert.throws(() => normalizeNotificationDestination("email", "not-an-email"), /valid email/);
});

test("U.S. mobile destinations normalize without exposing the full number", () => {
  assert.equal(normalizeNotificationDestination("sms", "(212) 555-0198"), "+12125550198");
  assert.equal(maskNotificationDestination("sms", "+12125550198"), "(***) ***-0198");
  assert.throws(() => normalizeNotificationDestination("sms", "555"), /valid U.S. mobile/);
});

test("scheduled events combine the late window with the pre-SNF alert", () => {
  const now = new Date("2026-09-13T23:55:00Z");
  const games = [
    { kickoff: "2026-09-13T17:00:00Z", state: "FINAL", spread: 3.5 },
    { kickoff: "2026-09-13T20:25:00Z", state: "FINAL", spread: 7 },
    { kickoff: "2026-09-14T00:20:00Z", state: "PREGAME", spread: 2.5 },
    { kickoff: "2026-09-15T00:15:00Z", state: "PREGAME", spread: 1.5 },
  ];
  assert.deepEqual(scheduledNotificationEvents(now, games, "live"), ["earlyWindow", "beforeSnf"]);
  assert.deepEqual(scheduledNotificationEvents(now, games, "staged"), ["earlyWindow", "beforeSnf"]);
  assert.deepEqual(scheduledNotificationEvents(now, games.map((game, index) => index ? game : { ...game, spread: "" }), "staged"), ["earlyWindow", "beforeSnf"]);
  assert.deepEqual(scheduledNotificationEvents(now, games.map((game, index) => index === 1 ? { ...game, state: "LIVE" } : game), "live"), ["earlyWindow"]);
});

test("picks due reminder honors a configurable lead time before the first kickoff", () => {
  const games = [{ kickoff: "2026-09-10T00:20:00Z", state: "PREGAME" }];
  assert.equal(picksDueReminderIsEligible(new Date("2026-09-10T00:04:59Z"), games, "staged", 15), false);
  assert.equal(picksDueReminderIsEligible(new Date("2026-09-10T00:05:00Z"), games, "staged", 15), true);
  assert.equal(picksDueReminderIsEligible(new Date("2026-09-10T00:10:00Z"), games, "staged", 10), true);
  assert.equal(picksDueReminderIsEligible(new Date("2026-09-09T19:20:00Z"), games, "staged", 300), true);
  assert.equal(picksDueReminderIsEligible(new Date("2026-09-10T00:20:00Z"), games, "staged", 15), true);
  assert.equal(picksDueReminderIsEligible(new Date("2026-09-10T00:20:01Z"), games, "staged", 15), false);
});

test("weekly result is eligible only after finalization", () => {
  assert.deepEqual(scheduledNotificationEvents(new Date(), [], "finalized"), ["weeklyResult"]);
});

test("weekly result rank movement uses the completed season record", () => {
  assert.equal(
    seasonRankMovementSummary({ name: "Mel", rank: 8, wins: 27, losses: 28 }, { name: "Mel", rank: 16, wins: 34, losses: 37 }),
    "Mel drops from 8th pace to 16th place in the standings (34-37).",
  );
  assert.equal(
    seasonRankMovementSummary({ name: "Mel", rank: 19, wins: 27, losses: 28 }, { name: "Mel", rank: 12, wins: 34, losses: 37 }),
    "Mel jumps from 19th to 12th place in the standings (34-37).",
  );
});

test("first-place push names the scoring change and top two live probabilities", () => {
  assert.equal(
    leaderPushSummary(
      { name: "Jim", winProbability: 42.25 },
      { name: "Mel", winProbability: 27.5 },
      { team: "JAX", points: 7, opposingTeam: "ATL", teamScore: 21, opposingScore: 17, spread: -3.5 },
    ),
    "Live win probability: First Jim 42.3% · Second Mel 27.5%.\nJAX scored 7 points. JAX 21, ATL 17 (JAX -3.5).",
  );
});
