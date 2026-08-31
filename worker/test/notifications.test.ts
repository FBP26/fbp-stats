import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultNotificationPreferences,
  maskNotificationDestination,
  normalizeNotificationDestination,
  parseNotificationPreferences,
  picksDueReminderIsEligible,
  scheduledNotificationEvents,
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

test("scheduled events follow completed Sunday windows and upcoming night games", () => {
  const now = new Date("2026-09-13T23:55:00Z");
  const games = [
    { kickoff: "2026-09-13T17:00:00Z", state: "FINAL", spread: 3.5 },
    { kickoff: "2026-09-13T20:25:00Z", state: "FINAL", spread: 7 },
    { kickoff: "2026-09-14T00:20:00Z", state: "PREGAME", spread: 2.5 },
    { kickoff: "2026-09-15T00:15:00Z", state: "PREGAME", spread: 1.5 },
  ];
  assert.deepEqual(scheduledNotificationEvents(now, games, "live"), ["earlyWindow", "lateWindow", "beforeSnf"]);
  assert.deepEqual(scheduledNotificationEvents(now, games, "staged"), ["picksReady", "earlyWindow", "lateWindow", "beforeSnf"]);
  assert.deepEqual(scheduledNotificationEvents(now, games.map((game, index) => index ? game : { ...game, spread: "" }), "staged"), ["earlyWindow", "lateWindow", "beforeSnf"]);
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
