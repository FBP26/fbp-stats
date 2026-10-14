const url = "https://sports.yahoo.com/nfl/scoreboard/?season=2026&seasonPhase=REGULAR_SEASON&week=6";
const source = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; FBP-Worker/1.0)" } })).text();
const espn = await (await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=2026&seasontype=2&week=6&limit=100")).json();
const jsonLd = source.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
const schedule = jsonLd ? JSON.parse(jsonLd) : null;
const firstUrl = schedule?.itemListElement?.[0]?.item?.url || "";
const firstId = firstUrl.match(/(\d{11})\/?$/)?.[1] || "";
const escapedMarker = `\\"gameId\\":\\"nfl.g.${firstId}\\"`;
const plainMarker = `"gameId":"nfl.g.${firstId}"`;
const abbreviations = { "Seattle Seahawks": "SEA", "Denver Broncos": "DEN", "Houston Texans": "HOU", "Jacksonville Jaguars": "JAX", "Chicago Bears": "CHI", "Atlanta Falcons": "ATL" };
const parsed = (schedule?.itemListElement || []).map(entry => {
  const event = entry.item || {};
  const id = String(event.url || "").match(/(\d{11})\/?$/)?.[1] || "";
  const gameId = id ? `nfl.g.${id}` : "";
  const marker = `\\"gameId\\":\\"${gameId}\\"`;
  const start = source.indexOf(marker, Math.max(source.indexOf('\\"initialGames\\"'), 0));
  const next = start < 0 ? -1 : source.indexOf('\\"gameId\\":\\"nfl.g.', start + marker.length);
  const block = start < 0 ? "" : source.slice(start, next < 0 ? start + 18000 : next).replace(/\\"/g, '"').replace(/\\u0026/g, "&");
  const spread = block.match(/"type":"SPREAD","options":\[\{"shortName":"(-?\d+(?:\.\d+)?)"[\s\S]{0,180}?"abbreviation":"([A-Z]+)"/) || [];
  return { gameId, start, away: event.awayTeam?.name, home: event.homeTeam?.name, spread: spread[1] || "", favorite: spread[2] || "", odds: block.match(/"type":"SPREAD"[\s\S]{0,350}/)?.[0] || "" };
});
console.log(JSON.stringify({
  bytes: source.length,
  hasJsonLd: Boolean(jsonLd),
  itemCount: schedule?.itemListElement?.length || 0,
  hasInitialGames: source.includes('\\"initialGames\\"'),
  firstId,
  escapedMarkerIndex: source.indexOf(escapedMarker),
  plainMarkerIndex: source.indexOf(plainMarker),
  parsed,
  espn: (espn.events || []).map(event => {
    const competition = event.competitions?.[0] || {};
    const away = competition.competitors?.find(team => team.homeAway === "away")?.team?.abbreviation || "";
    const home = competition.competitors?.find(team => team.homeAway === "home")?.team?.abbreviation || "";
    return { id: event.id, date: event.date, away, home, odds: competition.odds?.[0]?.details || "" };
  }),
  urls: (schedule?.itemListElement || []).slice(0, 3).map(entry => entry.item?.url || ""),
}, null, 2));
