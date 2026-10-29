const apiUrl = process.env.FBP_API_URL || "https://fbp-api.fbp-api-worker.workers.dev";
const siteUrl = process.env.FBP_SITE_URL || "https://fbp26.github.io/fbp-stats/";
const browserOrigin = "https://fbp26.github.io";

const fail = message => { throw new Error(message); };
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchWithRetry(endpoint, options, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, options);
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new Error(`Public request returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await wait(1_000 * attempt);
  }
  throw lastError;
}

async function main() {
async function request(endpoint, timeout = 30_000) {
  const response = await fetchWithRetry(endpoint, {
    headers: { Origin: browserOrigin },
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json().catch(() => null);
  if (response.headers.get("access-control-allow-origin") !== browserOrigin) fail(`Browser CORS contract failed for ${endpoint}.`);
  if (!response.ok || !body?.ok) fail(`Public API failed for ${endpoint}: ${body?.error || response.status}.`);
  return body;
}

function api(action, parameters = {}) {
  const url = new URL(apiUrl);
  url.search = new URLSearchParams({ action, ...parameters, _: String(Date.now()) });
  return url;
}

const page = await fetchWithRetry(siteUrl, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
const html = await page.text();
if (!page.ok || !html.includes("WEBSITE_SUBMISSIONS_ENDPOINT") || !html.includes(new URL(apiUrl).host)) {
  fail("Published FBP page is unavailable or is not configured to use the public API.");
}

const status = await request(api("backend-status"));
if (status.owner !== "D1" || status.writesEnabled !== true) fail("Pick submissions are not enabled on the public API.");

const active = await request(api("active-week", { enrich: "0" }));
if (!active.staged) {
  console.log(JSON.stringify({ ok: true, state: "no-active-week" }));
  process.exit(0);
}
if (!Number.isInteger(active.season) || !Number.isInteger(active.week) || !Array.isArray(active.games) || !active.games.length) {
  fail("Active Week is missing a valid staged slate.");
}

const lookup = await request(api("existing-submission", {
  season: active.season,
  week: active.week,
  phase: active.phase || "REGULAR_SEASON",
  name: "Health Check",
}));
if (lookup.owner !== "D1" || lookup.writesEnabled !== true || lookup.exists !== false) {
  fail("The active week is visible but new-pick lookup is not enabled.");
}

console.log(JSON.stringify({ ok: true, season: active.season, week: active.week, games: active.games.length, players: current.players?.length || 0 }));
}

await main().catch(error => {
  console.error(`FBP public health check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});