// Weekly end-to-end check of the pick pipeline on the test copy (fbp-api-staging, a copy of production data that can
// never message anyone). Submits a test entry for the open week, fixes it with the edit key, confirms a different
// "device" (no key) is refused, and reads the entry back. Exits non-zero on any failure so GitHub flags the run.
const api = process.env.FBP_STAGING_API || "https://fbp-api-staging.fbp-api-worker.workers.dev/";
const name = "FBP Test Bot";
const get = async (params) => {
  const url = new URL(api);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  return { status: response.status, body: await response.json() };
};
const post = async (payload) => {
  const response = await fetch(api, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) });
  return { status: response.status, body: await response.json() };
};
const check = (condition, message) => { if (!condition) { console.error(`FAIL: ${message}`); process.exit(1); } console.log(`ok - ${message}`); };

const active = await get({ action: "active-week" });
check(active.body.ok, "active-week responds");
if (!active.body.staged || !(active.body.games || []).length) {
  console.log(`No week is open on the test copy (latest is Week ${active.body.week}); nothing to submit. This is normal between weeks.`);
  process.exit(0);
}
const { season, week, phase } = active.body;
const games = active.body.games;
const firstKickoff = Math.min(...games.map((game) => Date.parse(game.kickoff)));
if (Date.now() >= firstKickoff) { console.log(`Week ${week} has already kicked off; edit checks skipped.`); process.exit(0); }
const base = { mode: "production", season, week, phase, name, weekName: "Weekly pipeline check", tiebreaker: 400, browserId: "" };
const favorites = games.map((game) => game.favorite);
const first = await post({ ...base, picks: favorites, bestBet: favorites[0] });
check(first.body.ok && first.body.editKey, `submit Week ${week} picks (${games.length} games) and receive an edit key`);
const underdogs = games.map((game) => game.underdog);
const fixed = await post({ ...base, picks: underdogs, bestBet: underdogs[0], editKey: first.body.editKey });
check(fixed.body.ok, "fix the picks with the edit key");
const stranger = await post({ ...base, picks: favorites, bestBet: favorites[1] });
check(stranger.status === 409 && stranger.body.otherDevice, "a different device without the key is refused");
const saved = await get({ action: "existing-submission", season, week, phase, name });
check(saved.body.exists && saved.body.player.picks.join() === underdogs.join() && saved.body.player.bestBet === underdogs[0], "saved entry matches the fixed picks");
console.log(`Week ${week} pick pipeline OK on the test copy.`);
