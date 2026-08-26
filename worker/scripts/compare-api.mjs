const DEFAULT_SOURCE_API = "https://script.google.com/macros/s/AKfycbxZUgJm6LstCEomhmrlJYa_nH7tsmxC_4UZwYdroIZbs-PeI6KdPqUZtsF9fZvr_YuNWQ/exec";
const DEFAULT_TARGET_API = "https://fbp-api.fbp-api-worker.workers.dev/";

const optionValue = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const fetchAction = async (endpoint, action, parameters = {}) => {
  const url = new URL(endpoint);
  url.searchParams.set("action", action);
  Object.entries(parameters).forEach(([name, value]) => url.searchParams.set(name, String(value)));
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${payload.error || "unknown error"}`);
  return payload;
};

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
};

const differingKeys = (left, right) => [...new Set([...Object.keys(left), ...Object.keys(right)])]
  .filter(key => JSON.stringify(canonical(left[key])) !== JSON.stringify(canonical(right[key])));

const assertParity = (label, source, target) => {
  const equal = JSON.stringify(canonical(source)) === JSON.stringify(canonical(target));
  if (!equal) throw new Error(`${label} differs in top-level field(s): ${differingKeys(source, target).join(", ")}`);
  console.log(`${label}: parity passed.`);
};

const validTiebreaker = (player) => {
  const value = Number(player.tiebreaker);
  return Number.isFinite(value) && value >= -100 && value <= 1200;
};

const removeVolatileWeather = (payload) => {
  const volatileFields = ["temperature", "weather", "weatherSource", "weatherLink"];
  for (const game of payload.games || []) {
    volatileFields.forEach(field => delete game[field]);
  }
};

const main = async () => {
  const sourceApi = optionValue("--source", process.env.FBP_SOURCE_API || DEFAULT_SOURCE_API);
  const targetApi = optionValue("--target", process.env.FBP_TARGET_API || DEFAULT_TARGET_API);
  const phase = String(optionValue("--phase", "REGULAR_SEASON")).toUpperCase();

  if (phase === "PRESEASON") {
    const season = Number(optionValue("--season", ""));
    const week = Number(optionValue("--week", ""));
    if (!Number.isInteger(season) || !Number.isInteger(week)) {
      throw new Error("Preseason parity requires integer --season and --week values.");
    }
    const parameters = { season, week };
    const [source, target] = await Promise.all([
      fetchAction(sourceApi, "preseason-test", parameters),
      fetchAction(targetApi, "preseason-test", parameters),
    ]);
    if (process.argv.includes("--skip-invalid-test-cards")) {
      source.players = source.players.filter(validTiebreaker);
    }
    removeVolatileWeather(source);
    removeVolatileWeather(target);
    delete source.updatedAt;
    delete target.updatedAt;
    delete source.raceSnapshots;
    delete target.raceSnapshots;
    assertParity(`Preseason ${season} Week ${week}`, source, target);
    console.log(`${target.games.length} games and ${target.players.length} players compared.`);
    return;
  }

  if (phase !== "REGULAR_SEASON") throw new Error("--phase must be REGULAR_SEASON or PRESEASON.");
  const [sourceActive, targetActive] = await Promise.all([
    fetchAction(sourceApi, "active-week"),
    fetchAction(targetApi, "active-week"),
  ]);
  assertParity("Regular-season active-week", sourceActive, targetActive);
  if (!sourceActive.staged) {
    console.log("No regular-season week is staged; current-week parity is deferred.");
    return;
  }
  const [sourceCurrent, targetCurrent] = await Promise.all([
    fetchAction(sourceApi, "current-week"),
    fetchAction(targetApi, "current-week"),
  ]);
  removeVolatileWeather(sourceCurrent);
  removeVolatileWeather(targetCurrent);
  delete sourceCurrent.updatedAt;
  delete targetCurrent.updatedAt;
  assertParity(`Regular season ${sourceActive.season} Week ${sourceActive.week}`, sourceCurrent, targetCurrent);
  console.log(`${targetCurrent.games.length} games, ${targetCurrent.players.length} players, and ${targetCurrent.raceSnapshots.length} race frames compared.`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});