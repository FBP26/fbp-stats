import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const root = path.dirname(modulePath);
const recapDirectory = path.join(root, "data", "winner-recaps");

// games.json carries venue metadata only for some weeks; neutral-site games whose
// rows have a null stadiumId are mapped here by season|week|AWAY@HOME.
// Venue ids match FBP_MAP_VENUES in map.js where that file already defines them.
const NEUTRAL_SITE_GAMES = {
  "2026-2027|3|BAL@DAL": "RIO00",
  "2026-2027|4|IND@WAS": "LON02",
  "2026-2027|5|PHI@JAX": "LON02",
  "2026-2027|6|HOU@JAX": "LON00",
};

// Venues absent from FBP_MAP_VENUES in map.js.
const EXTRA_VENUES = {
  MEL00: { city: "Melbourne, Australia", country: "Australia", lat: -37.8200, lng: 144.9834 },
  RIO00: { city: "Rio de Janeiro, Brazil", country: "Brazil", lat: -22.9121, lng: -43.2302 },
};

const STADIUM_NAMES = {
  MEL00: "Melbourne Cricket Ground",
  RIO00: "Maracanã Stadium",
  LON00: "Wembley Stadium",
  LON02: "Tottenham Hotspur Stadium",
};

function extractObject(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`${name} not found in map.js`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (!depth) return new Function(`return ${source.slice(source.indexOf("{", start), index + 1)}`)();
    }
  }
  throw new Error(`${name} object never closed in map.js`);
}

const normalizeTeam = value => String(value || "").trim().toUpperCase();

function resolveVenue(game, recapGame, markets, venues, overrideId) {
  const stadiumId = overrideId || String(game?.stadiumId || "").trim();
  const market = stadiumId ? venues[stadiumId] || EXTRA_VENUES[stadiumId] : null;
  if (market) {
    return {
      lat: market.lat,
      lng: market.lng,
      city: market.city,
      country: market.country,
      stadium: game?.stadium || STADIUM_NAMES[stadiumId] || "",
      neutralSite: Boolean(overrideId) || Boolean(game?.neutralSite),
      international: market.country !== "USA",
      source: "venue",
    };
  }
  const home = markets[normalizeTeam(recapGame.home)];
  if (!home) return null;
  return {
    lat: home.lat,
    lng: home.lng,
    city: home.city,
    country: "USA",
    stadium: home.stadium,
    neutralSite: false,
    international: false,
    source: "market",
  };
}

export async function buildWinnerVenues() {
  const mapSource = await readFile(path.join(root, "map.js"), "utf8");
  const markets = extractObject(mapSource, "FBP_MAP_MARKETS");
  const venues = extractObject(mapSource, "FBP_MAP_VENUES");
  const games = JSON.parse(await readFile(path.join(root, "data", "games.json"), "utf8"));
  const index = JSON.parse(await readFile(path.join(recapDirectory, "index.json"), "utf8"));

  const byKey = new Map();
  games.forEach(game => byKey.set(`${game.season}|${game.week}|${game.gameNum}`, game));

  const output = {};
  const missingVenues = new Set();
  for (const week of index.weeks) {
    const recap = JSON.parse(await readFile(path.join(recapDirectory, week.file), "utf8"));
    const entries = recap.games.map(recapGame => {
      const source = byKey.get(`${recap.seasonLabel}|${week.week}|${recapGame.gameNum}`);
      const matchup = `${normalizeTeam(recapGame.away)}@${normalizeTeam(recapGame.home)}`;
      const overrideId = NEUTRAL_SITE_GAMES[`${recap.seasonLabel}|${week.week}|${matchup}`] || "";
      const stadiumId = overrideId || String(source?.stadiumId || "").trim();
      if (stadiumId && !venues[stadiumId] && !EXTRA_VENUES[stadiumId]) missingVenues.add(stadiumId);
      const resolved = resolveVenue(source, recapGame, markets, venues, overrideId);
      return resolved ? { gameNum: recapGame.gameNum, ...resolved } : null;
    }).filter(Boolean);
    output[`${recap.seasonLabel}|${week.week}`] = entries;
    const international = entries.filter(entry => entry.international).length;
    console.log(`${week.file}: ${entries.length} located, ${international} international.`);
  }
  if (missingVenues.size) console.warn(`Venues without coordinates: ${[...missingVenues].join(", ")}`);
  await writeFile(path.join(recapDirectory, "venues.json"), JSON.stringify({ generatedAt: new Date().toISOString(), weeks: output }));
  console.log("Wrote data/winner-recaps/venues.json");
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  buildWinnerVenues().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
