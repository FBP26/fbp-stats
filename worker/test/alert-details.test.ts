import assert from "node:assert/strict";
import test from "node:test";
import { alertEmailHtml, alertKickoff, nightPaths, observeLeads, parseAlertFeed, tiebreakNeed } from "../src/alert-details.ts";
import type { AlertFeed } from "../src/alert-details.ts";
import worker, { dispatchWeekNotifications } from "../src/index.ts";

const feed: AlertFeed = {
  games: [{ gameId: "1", favorite: "BUF", underdog: "MIA", spread: 3.5, status: "LIVE", favoriteScore: 0, underdogScore: 7, kickoff: "2026-09-14T00:20:00Z", period: "1", clock: "5:00" }],
  cards: [
    { name: "Jim", weekName: "A", picks: ["BUF"], bestBet: "BUF", tiebreaker: 400 },
    { name: "Bo", weekName: "B", picks: ["MIA"], bestBet: "MIA", tiebreaker: 450 },
  ],
};
test("Yahoo local kickoffs use the season year and Eastern daylight or standard time", () => {
  assert.equal(alertKickoff("Thu 9/24 8:15 PM", 2026), "2026-09-25T00:15:00.000Z");
  assert.equal(alertKickoff("Sun 1/3 1:00 PM", 2026), "2027-01-03T18:00:00.000Z");
  assert.throws(() => alertKickoff("TBD", 2026));
});
test("first-place alerts require observed jumps, not card order or initial baseline", () => {
  const first = observeLeads(feed, null, "2026-09-14T00:30:00Z");
  assert.deepEqual(first.ranks, { Jim: 2, Bo: 1 });
  assert.deepEqual(first.changes, {});
  const next = observeLeads({ ...feed, games: [{ ...feed.games[0], favoriteScore: 14 }] }, first, "2026-09-14T00:35:00Z");
  assert.equal(next.changes.Jim.from, 2);
  assert.match(next.changes.Jim.events[0], /Best Bet.*\+2 wins/);
  assert.equal(next.changes.Jim.at, "2026-09-14T00:35:00Z");
  assert.equal(observeLeads({ ...feed, games: next.games }, next, "2026-09-14T00:40:00Z").changes.Jim.at, next.changes.Jim.at);
});
test("live games stay unresolved for exact night paths; eliminated players receive no alert", () => {
  assert.equal(nightPaths(feed, "Jim").count, 1);
  assert.match(nightPaths(feed, "Jim").examples[0], /BUF covers.*outright first/);
  const final: AlertFeed = { ...feed, games: [{ ...feed.games[0], status: "FINAL" }] };
  assert.equal(nightPaths(final, "Jim").eligible, false);
  const push: AlertFeed = { ...feed, games: [{ ...feed.games[0], spread: 3 }] };
  assert.equal(nightPaths(push, "Jim").total, 3);
  assert.match(nightPaths(push, "Jim").examples.join("\n"), /pushes.*tied.*net passing decides/);
});
test("alert feed rejects wrong weeks, incomplete cards and unknown scores", () => {
  assert.throws(() => parseAlertFeed({ ok: true, season: 2026, week: 2, games: [], players: [] }, 2026, 3));
  assert.throws(() => parseAlertFeed({ ok: true, season: 2026, week: 3, games: [{ ...feed.games[0], favoriteScore: "" }], players: feed.cards }, 2026, 3));
  assert.equal(parseAlertFeed({ ok: true, season: 2026, week: 3, games: feed.games, players: feed.cards }, 2026, 3).cards.length, 2);
});
test("email content escapes player text and provides both action buttons", () => {
  const html = alertEmailHtml("First <place>", "<script>bad</script>", "https://example.com/", "https://example.com/stop");
  assert.match(html, /Open FBP/);
  assert.match(html, /Stop notifications/);
  assert.ok(!html.includes("<script>"));
});

test("dispatch sends a lone one-minute reminder, skips submitted cards, deduplicates and fails closed", async () => {
  const originalFetch = globalThis.fetch;
  const deliveries = new Map<string, string>();
  const sent: { body: string; htmlBody: string }[] = [];
  let observation = "";
  const kickoff = new Date(Date.now() + 45000).toISOString();
  const live = { ok: true, staged: true, season: 2026, week: 3, games: [{ ...feed.games[0], status: "PREGAME", kickoff, favoriteScore: null, underdogScore: null }], players: [] as typeof feed.cards };
  const subscription = { id: 1, player_name: "Jim", destination: "fixture@example.com", picks_due: 1, picks_due_minutes: 1, manage_token: "test-only" };
  const db = { prepare(sql: string) {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async all() {
        if (sql.includes("FROM games g")) return { results: [{ game_index: 0, external_id: "1", favorite: "BUF", underdog: "MIA", spread: 3.5, kickoff_at: kickoff }] };
        if (sql.includes("notification_subscriptions")) return { results: [subscription] };
        if (sql.includes("canonical_name")) return { results: [] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
      async first() {
        if (sql.includes("notification_observations")) return observation ? { payload_json: observation } : null;
        if (sql.includes("notification_deliveries")) return { status: deliveries.get(String(args[1])) };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      async run() {
        if (sql.startsWith("INSERT INTO notification_observations")) { observation = String(args[2]); return { meta: { changes: 1 } }; }
        if (sql.startsWith("INSERT INTO notification_deliveries")) {
          const key = String(args[3]);
          if (deliveries.has(key)) return { meta: { changes: 0 } };
          deliveries.set(key, "queued");
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE notification_deliveries")) { deliveries.set(String(args[4]), String(args[0])); return { meta: { changes: 1 } }; }
        throw new Error(`Unexpected run query: ${sql}`);
      },
    };
  } };
  const env = { DB: db, CORS_ORIGIN: "*", EMAIL_RELAY_URL: "https://fixture.test/relay", EMAIL_RELAY_SECRET: "fixture", PICKS_SOURCE_URL: "https://fixture.test/source" } as unknown as Parameters<typeof dispatchWeekNotifications>[0];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/source")) return Response.json(live);
    if (String(url).includes("/relay")) { sent.push(JSON.parse(String(options?.body))); return Response.json({ ok: true }); }
    if (String(url).includes("players.json")) return Response.json([{ name: "Jim" }]);
    throw new Error("Unexpected network call");
  };
  try {
    const week = { id: 3, season: 2026, week: 3, status: "staged" };
    assert.equal((await dispatchWeekNotifications(env, week)).sent, 1);
    assert.match(sent[0].htmlBody, /Open FBP.*Stop notifications/s);
    assert.equal((await dispatchWeekNotifications(env, week)).sent, 0);
    deliveries.clear();
    live.players = feed.cards;
    assert.equal((await dispatchWeekNotifications(env, week)).sent, 0);
    live.week = 2;
    await assert.rejects(dispatchWeekNotifications(env, week), /another week/);
    for (const playerName of ["", "Unknown Player"]) {
      const response = await worker.fetch(new Request("https://fixture.test/", { method: "POST", body: JSON.stringify({ action: "subscribe-notifications", channel: "email", playerName, destination: "fixture@example.com" }) }), env);
      assert.equal(response.status, 400);
    }
    for (const minutes of [0, 241, 1.5]) {
      const response = await worker.fetch(new Request("https://fixture.test/", { method: "POST", body: JSON.stringify({ action: "subscribe-notifications", channel: "email", playerName: " jim ", destination: "fixture@example.com", picksDueMinutes: minutes }) }), env);
      assert.equal(response.status, 400);
      assert.match(await response.text(), /whole number/);
    }
    assert.equal(sent.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});
test("tiebreak guidance respects integer boundaries, decimals and identical guesses", () => {
  assert.match(tiebreakNeed(feed.cards[0], [feed.cards[1]]), /424 or fewer yards; 425 yards ties/);
  assert.match(tiebreakNeed(feed.cards[1], [feed.cards[0]]), /426 or more yards; 425 yards ties/);
  assert.match(tiebreakNeed(feed.cards[0], [{ ...feed.cards[1], tiebreaker: 451 }]), /425 or fewer yards$/);
  assert.match(tiebreakNeed(feed.cards[0], [{ ...feed.cards[1], tiebreaker: 400 }]), /any total.*same guess.*shared result/);
  const impossible: AlertFeed = { ...feed, cards: [
    { ...feed.cards[0], tiebreaker: 400.1 },
    { ...feed.cards[0], name: "Low", tiebreaker: 400 },
    { ...feed.cards[0], name: "High", tiebreaker: 400.2 },
  ] };
  assert.equal(nightPaths(impossible, "Jim").eligible, false);
  assert.equal(nightPaths(impossible, "Low").eligible, true);
});
test("shared-first entries and regaining first create distinct observed transitions", () => {
  const first = observeLeads(feed, null, "2026-09-14T00:30:00Z");
  const tiedFeed: AlertFeed = { ...feed, games: [{ ...feed.games[0], spread: 3, favoriteScore: 10 }] };
  const tied = observeLeads(tiedFeed, first, "2026-09-14T00:35:00Z");
  assert.equal(tied.changes.Jim.tied, true);
  const lost = observeLeads(feed, tied, "2026-09-14T00:40:00Z");
  assert.equal(lost.changes.Jim, undefined);
  const regained = observeLeads(tiedFeed, lost, "2026-09-14T00:45:00Z");
  assert.notEqual(regained.changes.Jim.at, tied.changes.Jim.at);
});

test("live alert source matches the approved slate without sending mail", { skip: !process.env.LIVE_ALERT_SOURCE }, async () => {
  const response = await fetch(`${process.env.LIVE_ALERT_SOURCE}?action=current-week&fast=1&_=${Date.now()}`);
  assert.equal(response.ok, true);
  const current = await response.json();
  const approved = await (await fetch("https://fbp-api.fbp-api-worker.workers.dev/?action=active-week")).json();
  const parsed = parseAlertFeed(current, Number(approved.season), Number(approved.week));
  assert.equal(current.staged, true);
  assert.equal(parsed.games.length, approved.games.length);
  for (const game of parsed.games) {
    assert.ok(approved.games.some((row: Record<string, unknown>) => String(row.gameId) === game.gameId && String(row.favorite).toUpperCase() === game.favorite && String(row.underdog).toUpperCase() === game.underdog && Number(row.spread) === game.spread));
    assert.ok(Date.parse(game.kickoff) > Date.UTC(Number(approved.season), 7, 1));
  }
  console.log(`Read-only source validation: week ${approved.week}, ${parsed.games.length} approved games, ${parsed.cards.length} complete cards.`);
});