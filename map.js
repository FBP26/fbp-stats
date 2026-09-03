const FBP_MAP_MARKETS = {
  ARI: { city: "Glendale, AZ", stadium: "State Farm Stadium", lat: 33.5276, lng: -112.2626 },
  ATL: { city: "Atlanta, GA", stadium: "Mercedes-Benz Stadium", lat: 33.7554, lng: -84.4008 },
  BAL: { city: "Baltimore, MD", stadium: "M&T Bank Stadium", lat: 39.2780, lng: -76.6227 },
  BUF: { city: "Orchard Park, NY", stadium: "Highmark Stadium", lat: 42.7738, lng: -78.7868 },
  CAR: { city: "Charlotte, NC", stadium: "Bank of America Stadium", lat: 35.2258, lng: -80.8528 },
  CHI: { city: "Chicago, IL", stadium: "Soldier Field", lat: 41.8623, lng: -87.6167 },
  CIN: { city: "Cincinnati, OH", stadium: "Paycor Stadium", lat: 39.0954, lng: -84.5160 },
  CLE: { city: "Cleveland, OH", stadium: "Huntington Bank Field", lat: 41.5061, lng: -81.6995 },
  DAL: { city: "Arlington, TX", stadium: "AT&T Stadium", lat: 32.7473, lng: -97.0945 },
  DEN: { city: "Denver, CO", stadium: "Empower Field at Mile High", lat: 39.7439, lng: -105.0201 },
  DET: { city: "Detroit, MI", stadium: "Ford Field", lat: 42.3400, lng: -83.0456 },
  GB: { city: "Green Bay, WI", stadium: "Lambeau Field", lat: 44.5013, lng: -88.0622 },
  HOU: { city: "Houston, TX", stadium: "NRG Stadium", lat: 29.6847, lng: -95.4107 },
  IND: { city: "Indianapolis, IN", stadium: "Lucas Oil Stadium", lat: 39.7601, lng: -86.1639 },
  JAX: { city: "Jacksonville, FL", stadium: "EverBank Stadium", lat: 30.3239, lng: -81.6373 },
  KC: { city: "Kansas City, MO", stadium: "Arrowhead Stadium", lat: 39.0489, lng: -94.4839 },
  LAC: { city: "Inglewood, CA", stadium: "SoFi Stadium", lat: 33.9532, lng: -118.3377 },
  LAR: { city: "Inglewood, CA", stadium: "SoFi Stadium", lat: 33.9539, lng: -118.3392 },
  LV: { city: "Las Vegas, NV", stadium: "Allegiant Stadium", lat: 36.0908, lng: -115.1830 },
  MIA: { city: "Miami Gardens, FL", stadium: "Hard Rock Stadium", lat: 25.9580, lng: -80.2389 },
  MIN: { city: "Minneapolis, MN", stadium: "U.S. Bank Stadium", lat: 44.9738, lng: -93.2581 },
  NE: { city: "Foxborough, MA", stadium: "Gillette Stadium", lat: 42.0909, lng: -71.2643 },
  NO: { city: "New Orleans, LA", stadium: "Caesars Superdome", lat: 29.9511, lng: -90.0812 },
  NYG: { city: "East Rutherford, NJ", stadium: "MetLife Stadium", lat: 40.8147, lng: -74.0745 },
  NYJ: { city: "East Rutherford, NJ", stadium: "MetLife Stadium", lat: 40.8129, lng: -74.0761 },
  PHI: { city: "Philadelphia, PA", stadium: "Lincoln Financial Field", lat: 39.9008, lng: -75.1675 },
  PIT: { city: "Pittsburgh, PA", stadium: "Acrisure Stadium", lat: 40.4468, lng: -80.0158 },
  SEA: { city: "Seattle, WA", stadium: "Lumen Field", lat: 47.5952, lng: -122.3316 },
  SF: { city: "Santa Clara, CA", stadium: "Levi's Stadium", lat: 37.4030, lng: -121.9700 },
  TB: { city: "Tampa, FL", stadium: "Raymond James Stadium", lat: 27.9759, lng: -82.5033 },
  TEN: { city: "Nashville, TN", stadium: "Nissan Stadium", lat: 36.1665, lng: -86.7713 },
  WAS: { city: "Landover, MD", stadium: "Northwest Stadium", lat: 38.9077, lng: -76.8645 }
};

const FBP_MAP_VENUES = {
  ATL00: { city: "Atlanta, GA", country: "USA", lat: 33.7575, lng: -84.4008 },
  ATL97: { city: "Atlanta, GA", country: "USA", lat: 33.7554, lng: -84.4008 },
  BAL00: { city: "Baltimore, MD", country: "USA", lat: 39.2780, lng: -76.6227 },
  BOS00: { city: "Foxborough, MA", country: "USA", lat: 42.0909, lng: -71.2643 },
  BUF00: { city: "Orchard Park, NY", country: "USA", lat: 42.7738, lng: -78.7868 },
  BUF01: { city: "Toronto, Canada", country: "Canada", lat: 43.6414, lng: -79.3894 },
  CAR00: { city: "Charlotte, NC", country: "USA", lat: 35.2258, lng: -80.8528 },
  CHI98: { city: "Chicago, IL", country: "USA", lat: 41.8623, lng: -87.6167 },
  CIN00: { city: "Cincinnati, OH", country: "USA", lat: 39.0954, lng: -84.5160 },
  CLE00: { city: "Cleveland, OH", country: "USA", lat: 41.5061, lng: -81.6995 },
  DAL00: { city: "Arlington, TX", country: "USA", lat: 32.7473, lng: -97.0945 },
  DEN00: { city: "Denver, CO", country: "USA", lat: 39.7439, lng: -105.0201 },
  DET00: { city: "Detroit, MI", country: "USA", lat: 42.3400, lng: -83.0456 },
  FRA00: { city: "Frankfurt, Germany", country: "Germany", lat: 50.0686, lng: 8.6455 },
  GER00: { city: "Munich, Germany", country: "Germany", lat: 48.2188, lng: 11.6247 },
  GNB00: { city: "Green Bay, WI", country: "USA", lat: 44.5013, lng: -88.0622 },
  HOU00: { city: "Houston, TX", country: "USA", lat: 29.6847, lng: -95.4107 },
  IND00: { city: "Indianapolis, IN", country: "USA", lat: 39.7601, lng: -86.1639 },
  JAX00: { city: "Jacksonville, FL", country: "USA", lat: 30.3239, lng: -81.6373 },
  KAN00: { city: "Kansas City, MO", country: "USA", lat: 39.0489, lng: -94.4839 },
  LAX01: { city: "Inglewood, CA", country: "USA", lat: 33.9535, lng: -118.3392 },
  LAX97: { city: "Carson, CA", country: "USA", lat: 33.8644, lng: -118.2611 },
  LAX99: { city: "Los Angeles, CA", country: "USA", lat: 34.0141, lng: -118.2879 },
  LON00: { city: "London, England", country: "England", lat: 51.5560, lng: -0.2796 },
  LON01: { city: "London, England", country: "England", lat: 51.4559, lng: -0.3415 },
  LON02: { city: "London, England", country: "England", lat: 51.6043, lng: -0.0664 },
  MEX00: { city: "Mexico City, Mexico", country: "Mexico", lat: 19.3029, lng: -99.1505 },
  MIA00: { city: "Miami Gardens, FL", country: "USA", lat: 25.9580, lng: -80.2389 },
  MIN00: { city: "Minneapolis, MN", country: "USA", lat: 44.9738, lng: -93.2581 },
  MIN01: { city: "Minneapolis, MN", country: "USA", lat: 44.9738, lng: -93.2581 },
  MIN98: { city: "Minneapolis, MN", country: "USA", lat: 44.9760, lng: -93.2249 },
  NAS00: { city: "Nashville, TN", country: "USA", lat: 36.1665, lng: -86.7713 },
  NOR00: { city: "New Orleans, LA", country: "USA", lat: 29.9511, lng: -90.0812 },
  NYC00: { city: "East Rutherford, NJ", country: "USA", lat: 40.8122, lng: -74.0769 },
  NYC01: { city: "East Rutherford, NJ", country: "USA", lat: 40.8135, lng: -74.0745 },
  OAK00: { city: "Oakland, CA", country: "USA", lat: 37.7516, lng: -122.2005 },
  PHI00: { city: "Philadelphia, PA", country: "USA", lat: 39.9008, lng: -75.1675 },
  PHO00: { city: "Glendale, AZ", country: "USA", lat: 33.5276, lng: -112.2626 },
  PIT00: { city: "Pittsburgh, PA", country: "USA", lat: 40.4468, lng: -80.0158 },
  SAO00: { city: "Sao Paulo, Brazil", country: "Brazil", lat: -23.5453, lng: -46.4742 },
  SDG00: { city: "San Diego, CA", country: "USA", lat: 32.7832, lng: -117.1225 },
  SEA00: { city: "Seattle, WA", country: "USA", lat: 47.5952, lng: -122.3316 },
  SFO00: { city: "San Francisco, CA", country: "USA", lat: 37.7136, lng: -122.3862 },
  SFO01: { city: "Santa Clara, CA", country: "USA", lat: 37.4030, lng: -121.9700 },
  STL00: { city: "St. Louis, MO", country: "USA", lat: 38.6328, lng: -90.1885 },
  TAM00: { city: "Tampa, FL", country: "USA", lat: 27.9759, lng: -82.5033 },
  VEG00: { city: "Las Vegas, NV", country: "USA", lat: 36.0908, lng: -115.1830 },
  WAS00: { city: "Landover, MD", country: "USA", lat: 38.9077, lng: -76.8645 }
};

const FBP_MAP_TEAM_ALIASES = { JAC: "JAX", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR", WSH: "WAS" };
const FBP_MAP_US_REGION_CENTERS = {
  AL:[32.8,-86.8], AK:[64.2,-152.5], AZ:[34.3,-111.7], AR:[34.9,-92.4], CA:[37.2,-119.7], CO:[39.0,-105.5], CT:[41.6,-72.7], DE:[39.0,-75.5], DC:[38.9,-77.0], FL:[28.6,-82.4], GA:[32.7,-83.3], HI:[20.8,-157.5], ID:[44.2,-114.7], IL:[40.0,-89.2], IN:[39.9,-86.3], IA:[42.1,-93.5], KS:[38.5,-98.3], KY:[37.5,-85.3], LA:[31.0,-92.0], ME:[45.3,-69.2], MD:[39.0,-76.7], MA:[42.3,-71.8], MI:[44.3,-85.6], MN:[46.3,-94.2], MS:[32.7,-89.7], MO:[38.4,-92.5], MT:[47.0,-109.6], NE:[41.5,-99.8], NV:[39.4,-116.6], NH:[43.7,-71.6], NJ:[40.1,-74.5], NM:[34.4,-106.1], NY:[42.9,-75.5], NC:[35.5,-79.4], ND:[47.5,-100.5], OH:[40.4,-82.8], OK:[35.6,-97.5], OR:[44.0,-120.6], PA:[40.9,-77.8], RI:[41.7,-71.6], SC:[33.8,-80.9], SD:[44.4,-100.2], TN:[35.8,-86.4], TX:[31.5,-99.3], UT:[39.3,-111.7], VT:[44.1,-72.7], VA:[37.5,-78.9], WA:[47.4,-120.7], WV:[38.6,-80.6], WI:[44.6,-89.6], WY:[43.0,-107.6]
};
const FBP_MAP_COUNTRY_CENTERS = { US:[39.5,-98.4], CA:[56.1,-106.3], GB:[54.0,-2.5], IE:[53.2,-8.2], MX:[23.6,-102.5], BR:[-10.8,-52.9], DE:[51.2,10.4], FR:[46.2,2.2], ES:[40.3,-3.7], IT:[42.8,12.8], NL:[52.2,5.3], AU:[-25.3,133.8] };
const FBP_MAP_METRICS = {
  support: { label: "Pool support", low: "rarely backed", high: "heavily backed", format: value => `${value.toFixed(1)}%`, value: row => row.supportRate * 100 },
  edge: { label: "Pool edge", low: "costly picks", high: "profitable picks", format: value => `${value.toFixed(1)}%`, value: row => row.pickRate * 100 },
  cover: { label: "ATS reality", low: "rarely covered", high: "often covered", format: value => `${value.toFixed(1)}%`, value: row => row.coverRate * 100 },
  weather: { label: "Temperature", low: "colder", high: "warmer", format: value => `${value.toFixed(1)}°F`, value: row => row.averageTemperature },
  wind: { label: "Wind", low: "calmer", high: "windier", format: value => `${value.toFixed(1)} mph`, value: row => row.averageWind },
  volume: { label: "Stadium history", low: "fewer games", high: "more games", format: value => `${Math.round(value)} game${Math.round(value) === 1 ? "" : "s"}`, value: row => row.mapGames?.length ?? row.homeGames.length },
  visitors: { label: "Website visitors", low: "fewer views", high: "more views", format: value => `${Math.round(value)} view${Math.round(value) === 1 ? "" : "s"}`, value: row => row.views }
};

let fbpMap = null;
let fbpMapMarkers = null;
let fbpMapReady = false;
let fbpMapSelectedTeam = "";
let fbpMapVisitorData = { updatedAt: "", locations: [] };
let fbpMapBaseLayers = [];

function fbpMapSetBasemap(style) {
  if (!fbpMap) return;
  fbpMapBaseLayers.forEach(layer => fbpMap.removeLayer(layer));
  const service = "https://server.arcgisonline.com/ArcGIS/rest/services";
  const options = { maxZoom: 18, attribution: "Tiles &copy; Esri" };
  if (style === "street") fbpMapBaseLayers = [L.tileLayer(`${service}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, options)];
  else if (style === "satellite") fbpMapBaseLayers = [
    L.tileLayer(`${service}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, options),
    L.tileLayer(`${service}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 18, attribution: "" })
  ];
  else fbpMapBaseLayers = [L.tileLayer(`${service}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, options)];
  fbpMapBaseLayers.forEach(layer => layer.addTo(fbpMap));
  fbpMapMarkers?.bringToFront?.();
}

function fbpMapNormalizeTeam(value) {
  const code = String(value || "").trim().toUpperCase();
  return FBP_MAP_TEAM_ALIASES[code] || code;
}

function fbpMapSeasonGames(season) {
  return websiteGames.filter(game => season === "all" || game.season === season);
}

function fbpMapTeamRows(season) {
  const analyticsRows = teamRowsForSeason(season);
  const statsByTeam = new Map();
  analyticsRows.forEach(row => {
    const team = fbpMapNormalizeTeam(row.team);
    const existing = statsByTeam.get(team);
    if (!existing) statsByTeam.set(team, { ...row, team });
    else ["picks", "wins", "losses", "pushes", "games", "covers", "noCovers", "gamePushes", "supportShareTotal", "supportGames", "bestBets", "bestBetWins", "bestBetLosses"].forEach(key => { existing[key] += Number(row[key] || 0); });
  });
  const seasonGames = fbpMapSeasonGames(season);
  return Object.keys(FBP_MAP_MARKETS).map(team => {
    const row = statsByTeam.get(team) || emptyTeamStat(team, season);
    const homeGames = seasonGames.filter(game => fbpMapNormalizeTeam(game.officialHome || game.home) === team && !game.neutralSite);
    const temperatures = homeGames.filter(game => game.temperatureF !== "" && game.temperatureF != null).map(game => Number(game.temperatureF)).filter(Number.isFinite);
    return {
      ...row,
      kind: "team",
      team,
      market: FBP_MAP_MARKETS[team],
      homeGames,
      pickRate: teamRate(row.wins, row.losses),
      coverRate: teamRate(row.covers, row.noCovers),
      bestBetRate: teamRate(row.bestBetWins, row.bestBetLosses),
      supportRate: row.supportGames ? row.supportShareTotal / row.supportGames : 0,
      averageTemperature: temperatures.length ? temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length : null,
      temperatureGames: temperatures.length
    };
  });
}

function fbpMapHistoricalVenueRows(season) {
  const grouped = new Map();
  fbpMapSeasonGames(season).forEach(game => {
    const venueId = String(game.stadiumId || "").trim();
    const market = FBP_MAP_VENUES[venueId];
    if (!venueId || !market) return;
    if (!grouped.has(venueId)) grouped.set(venueId, { kind: "venue", venueId, market, mapGames: [], names: new Set(), teams: new Set(), roofs: new Map(), surfaces: new Map() });
    const row = grouped.get(venueId);
    row.mapGames.push(game);
    if (game.stadium) row.names.add(game.stadium);
    [game.officialHome || game.home, game.officialAway || game.away].map(fbpMapNormalizeTeam).filter(Boolean).forEach(team => row.teams.add(team));
    if (game.roof) row.roofs.set(game.roof, (row.roofs.get(game.roof) || 0) + 1);
    if (game.surface) row.surfaces.set(game.surface, (row.surfaces.get(game.surface) || 0) + 1);
  });
  return [...grouped.values()].map(row => {
    const temperatures = row.mapGames.filter(game => game.temperatureF !== "" && game.temperatureF != null).map(game => Number(game.temperatureF)).filter(Number.isFinite);
    const winds = row.mapGames.filter(game => game.windMph !== "" && game.windMph != null).map(game => Number(game.windMph)).filter(Number.isFinite);
    const dates = row.mapGames.map(game => game.gameDate).filter(Boolean).sort();
    return { ...row, names: [...row.names], teams: [...row.teams], averageTemperature: temperatures.length ? temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length : null, averageWind: winds.length ? winds.reduce((sum, value) => sum + value, 0) / winds.length : null, temperatureGames: temperatures.length, windGames: winds.length, neutralGames: row.mapGames.filter(game => game.neutralSite).length, firstDate: dates[0] || "", lastDate: dates.at(-1) || "" };
  });
}

function fbpMapVisitorRows() {
  return (fbpMapVisitorData.locations || []).map(location => {
    const country = String(location.country || "").toUpperCase();
    const regionCode = String(location.regionCode || "").toUpperCase();
    const suppliedCoordinates = [Number(location.latitude), Number(location.longitude)];
    const coordinates = suppliedCoordinates.every(Number.isFinite) ? suppliedCoordinates : country === "US" ? FBP_MAP_US_REGION_CENTERS[regionCode] : FBP_MAP_COUNTRY_CENTERS[country];
    if (!coordinates) return null;
    return { ...location, kind: "visitor", visitorKey: `${country}|${regionCode || location.region}|${location.city || ""}`, market: { city: location.city || location.region || country, country, lat: coordinates[0], lng: coordinates[1] } };
  }).filter(Boolean);
}

function fbpMapMostCommon(values) {
  return [...values.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "No data";
}

function fbpMapRowKey(row) {
  return row.kind === "visitor" ? row.visitorKey : row.kind === "venue" ? row.venueId : row.team;
}

function fbpMapColor(value, minimum, maximum) {
  const ratio = maximum === minimum ? .5 : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  const stops = [[228, 91, 91], [229, 185, 76], [57, 201, 130]];
  const segment = ratio < .5 ? 0 : 1;
  const localRatio = ratio < .5 ? ratio * 2 : (ratio - .5) * 2;
  const start = stops[segment], end = stops[segment + 1];
  return `rgb(${start.map((channel, index) => Math.round(channel + (end[index] - channel) * localRatio)).join(",")})`;
}

function fbpMapMetricValue(row, metric) {
  const value = FBP_MAP_METRICS[metric].value(row);
  return Number.isFinite(value) ? value : null;
}

function fbpMapTeamVenueRows(row) {
  const counts = new Map();
  row.homeGames.forEach(game => {
    const venue = game.stadium || FBP_MAP_MARKETS[row.team].stadium;
    counts.set(venue, (counts.get(venue) || 0) + 1);
  });
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5);
}

function fbpMapRenderDetail(row, metric) {
  const host = document.getElementById("fbp-map-detail");
  if (!host || !row) return;
  if (row.kind === "visitor") {
    const location = [row.city, row.region, row.country].filter(Boolean).join(", ");
    host.innerHTML = `<div class="fbp-map-rail-head"><div><span class="fbp-map-rail-kicker">Approximate visitor geography</span><h3>${websiteEscapeHtml(location)}</h3></div></div><div class="fbp-map-stat-grid"><div><span>Page views</span><strong>${Number(row.views || 0).toLocaleString()}</strong></div><div><span>Unique browsers</span><strong>${Number(row.uniqueBrowsers || 0).toLocaleString()}</strong></div><div><span>Sessions</span><strong>${Number(row.sessions || 0).toLocaleString()}</strong></div><div><span>Pick starts</span><strong>${Number(row.pickStarts || 0).toLocaleString()}</strong></div><div><span>Pick submissions</span><strong>${Number(row.submissions || 0).toLocaleString()}</strong></div></div><p class="fbp-map-caption">Approximate network location from Cloudflare. No browser location permission is requested, and no IP addresses or anonymous IDs are included in this Map data.</p>`;
    return;
  }
  if (row.kind === "venue") {
    const title = row.names.at(-1) || row.venueId;
    const formerNames = row.names.filter(name => name !== title);
    const teams = row.teams.map(team => websiteNaturalTeamName(team.toLowerCase())).sort();
    host.innerHTML = `<div class="fbp-map-rail-head"><div><span class="fbp-map-rail-kicker">${websiteEscapeHtml(row.market.city)} · ${websiteEscapeHtml(row.market.country)}</span><h3>${websiteEscapeHtml(title)}</h3></div></div><div class="fbp-map-stat-grid"><div><span>${websiteEscapeHtml(FBP_MAP_METRICS[metric].label)}</span><strong>${FBP_MAP_METRICS[metric].format(fbpMapMetricValue(row, metric))}</strong></div><div><span>Pool games</span><strong>${row.mapGames.length.toLocaleString()}</strong></div><div><span>Average temp</span><strong>${row.averageTemperature == null ? "No data" : `${row.averageTemperature.toFixed(1)}°F`}</strong></div><div><span>Average wind</span><strong>${row.averageWind == null ? "No data" : `${row.averageWind.toFixed(1)} mph`}</strong></div><div><span>Roof</span><strong>${websiteEscapeHtml(fbpMapMostCommon(row.roofs))}</strong></div><div><span>Surface</span><strong>${websiteEscapeHtml(fbpMapMostCommon(row.surfaces))}</strong></div></div><p class="fbp-map-caption">${websiteEscapeHtml(row.firstDate)} through ${websiteEscapeHtml(row.lastDate)} · ${row.neutralGames} neutral-site game${row.neutralGames === 1 ? "" : "s"} · temperature on ${row.temperatureGames} games · wind on ${row.windGames}.</p><div class="fbp-map-venue-list"><h4>Names used during the pool</h4>${row.names.map(name => `<div><span>${websiteEscapeHtml(name)}</span></div>`).join("")}<h4>Teams seen here</h4><p class="fbp-map-caption">${websiteEscapeHtml(teams.join(" · ") || "No team data")}</p>${formerNames.length ? `<p class="fbp-map-caption">Current display name follows the latest archive record.</p>` : ""}</div>`;
    return;
  }
  const market = FBP_MAP_MARKETS[row.team], venues = fbpMapTeamVenueRows(row);
  const metricValue = fbpMapMetricValue(row, metric);
  host.innerHTML = `<div class="fbp-map-rail-head"><img src="${websiteEscapeHtml(websiteTeamLogoUrl(row.team.toLowerCase()))}" alt=""><div><span class="fbp-map-rail-kicker">${websiteEscapeHtml(market.city)}</span><h3>${websiteEscapeHtml(websiteNaturalTeamName(row.team.toLowerCase()))}</h3></div></div><div class="fbp-map-stat-grid"><div><span>${websiteEscapeHtml(FBP_MAP_METRICS[metric].label)}</span><strong>${metricValue == null ? "No data" : FBP_MAP_METRICS[metric].format(metricValue)}</strong></div><div><span>Pool picks</span><strong>${Number(row.picks || 0).toLocaleString()}</strong></div><div><span>When picked</span><strong>${row.wins + row.losses ? `${row.wins}-${row.losses}` : "No record"}</strong></div><div><span>Team ATS</span><strong>${row.covers + row.noCovers ? `${row.covers}-${row.noCovers}` : "No record"}</strong></div><div><span>Best Bets</span><strong>${Number(row.bestBets || 0).toLocaleString()}</strong></div><div><span>Avg. temp</span><strong>${row.averageTemperature == null ? "No data" : `${row.averageTemperature.toFixed(1)}°F`}</strong></div></div><p class="fbp-map-caption">Marker values use the selected season. Weather averages include archived home games with a recorded kickoff temperature.</p><div class="fbp-map-venue-list"><h4>Venue history</h4>${venues.length ? venues.map(([venue, count]) => `<div><span>${websiteEscapeHtml(venue)}</span><small>${count} game${count === 1 ? "" : "s"}</small></div>`).join("") : `<p class="fbp-map-empty">No home venue records in this slice.</p>`}</div>`;
}

function fbpMapRenderForecast() {
  const host = document.getElementById("fbp-map-forecast");
  if (!host) return;
  const games = (websiteActiveGames || []).filter(game => game.indoor || game.weather || game.temperature !== "" && game.temperature != null || game.wind || game.windMph !== "" && game.windMph != null);
  host.hidden = !games.length;
  if (!games.length) { host.innerHTML = ""; return; }
  host.innerHTML = `<div class="fbp-map-forecast-head"><span>Current slate forecast</span><strong>${games.length} reported</strong></div><div class="fbp-map-forecast-grid">${games.map(game => { const matchup = `${String(game.away || game.favorite || "").toUpperCase()} at ${String(game.home || game.underdog || "").toUpperCase()}`; const wind = game.windMph !== "" && game.windMph != null ? `${game.windMph} mph wind` : game.wind ? `${game.wind} wind` : ""; const conditions = game.indoor ? "Indoor" : [game.temperature !== "" && game.temperature != null ? `${game.temperature}°F` : "", game.weather, wind].filter(Boolean).join(" · "); const location = [game.venueName || game.venue, [game.venueCity, game.venueState].filter(Boolean).join(", "), game.kickoff, game.broadcast || game.tv].filter(Boolean).join(" · "); return `<div><span>${websiteEscapeHtml(matchup)}</span><strong>${websiteEscapeHtml(conditions)}</strong><small>${websiteEscapeHtml(location)}</small></div>`; }).join("")}</div>`;
}

function fbpMapRender() {
  if (!fbpMap || !fbpMapMarkers) return;
  const season = document.getElementById("fbp-map-season").value;
  const metric = document.getElementById("fbp-map-metric").value;
  const division = document.getElementById("fbp-map-division").value;
  const region = document.getElementById("fbp-map-region").value;
  const visitorMode = metric === "visitors";
  const venueMode = ["weather", "wind", "volume"].includes(metric);
  document.getElementById("fbp-map-season").disabled = visitorMode;
  document.getElementById("fbp-map-division").disabled = visitorMode;
  const rows = (visitorMode ? fbpMapVisitorRows() : venueMode ? fbpMapHistoricalVenueRows(season) : fbpMapTeamRows(season)).filter(row => {
    const divisionMatch = visitorMode || division === "all" || (row.kind === "venue" ? row.teams.some(team => WEBSITE_TEAM_DIVISIONS[team.toLowerCase()] === division) : WEBSITE_TEAM_DIVISIONS[row.team.toLowerCase()] === division);
    if (row.kind === "visitor") return divisionMatch && (region === "all" || region === (row.country === "US" ? "domestic" : "international"));
    const international = row.kind === "venue" && row.market.country !== "USA";
    const regionMatch = row.kind !== "venue" || region === "all" || region === (international ? "international" : "domestic");
    return divisionMatch && regionMatch;
  });
  const rowsWithValues = rows.filter(row => fbpMapMetricValue(row, metric) != null && (row.kind === "visitor" || row.kind === "venue" || metric === "volume" || row.picks || row.games || row.temperatureGames));
  const values = rowsWithValues.map(row => fbpMapMetricValue(row, metric));
  const minimum = values.length ? Math.min(...values) : 0, maximum = values.length ? Math.max(...values) : 1;
  fbpMapMarkers.clearLayers();
  rowsWithValues.forEach(row => {
    const market = row.market, value = fbpMapMetricValue(row, metric), key = fbpMapRowKey(row);
    const sample = row.kind === "visitor" ? row.views : row.kind === "venue" ? row.mapGames.length : Math.max(row.picks || 0, row.games || 0, row.homeGames.length);
    const radius = 8 + Math.min(12, Math.sqrt(sample) / 2.5);
    const marker = L.circleMarker([market.lat, market.lng], { radius, color: "#f3f1e8", weight: fbpMapSelectedTeam === key ? 3 : 1, fillColor: fbpMapColor(value, minimum, maximum), fillOpacity: .9 });
    const markerTitle = row.kind === "visitor" ? [row.city, row.region, row.country].filter(Boolean).join(", ") : row.kind === "venue" ? row.names.at(-1) || row.venueId : row.team;
    marker.bindTooltip(`<strong>${websiteEscapeHtml(markerTitle)}</strong> · ${websiteEscapeHtml(FBP_MAP_METRICS[metric].format(value))}`, { className: "fbp-map-tooltip", direction: "top" });
    marker.on("click", () => { fbpMapSelectedTeam = key; fbpMapRender(); fbpMapRenderDetail(row, metric); });
    marker.addTo(fbpMapMarkers);
    const markerElement = marker.getElement();
    markerElement?.setAttribute("tabindex", "0");
    markerElement?.setAttribute("role", "button");
    markerElement?.setAttribute("aria-label", `${markerTitle}, ${FBP_MAP_METRICS[metric].label}, ${FBP_MAP_METRICS[metric].format(value)}`);
    markerElement?.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); marker.fire("click"); } });
    if (row.kind === "team") L.marker([market.lat, market.lng], { interactive: false, icon: L.divIcon({ className: "fbp-map-team-label", html: row.team, iconSize: [28, 12], iconAnchor: [14, 6] }) }).addTo(fbpMapMarkers);
  });
  const sorted = [...rowsWithValues].sort((left, right) => fbpMapMetricValue(right, metric) - fbpMapMetricValue(left, metric));
  const leader = sorted[0], trailer = sorted.at(-1);
  const rowLabel = row => row.kind === "visitor" ? [row.city, row.region, row.country].filter(Boolean).join(", ") : row.kind === "venue" ? row.names.at(-1) || row.venueId : row.team;
  const totalViews = rowsWithValues.reduce((sum, row) => sum + Number(row.views || 0), 0);
  document.getElementById("fbp-map-summary").innerHTML = visitorMode ? `<div><span>Mapped regions</span><strong>${rowsWithValues.length}</strong></div><div><span>Page views</span><strong>${totalViews.toLocaleString()}</strong></div><div><span>Most traffic</span><strong>${leader ? `${rowLabel(leader)} · ${FBP_MAP_METRICS[metric].format(fbpMapMetricValue(leader, metric))}` : "No data"}</strong></div><div><span>Updated</span><strong>${fbpMapVisitorData.updatedAt ? new Date(fbpMapVisitorData.updatedAt).toLocaleDateString() : "Run export"}</strong></div>` : `<div><span>Mapped ${venueMode ? "venues" : "markets"}</span><strong>${rowsWithValues.length}</strong></div><div><span>Archived games</span><strong>${fbpMapSeasonGames(season).length.toLocaleString()}</strong></div><div><span>Highest</span><strong>${leader ? `${rowLabel(leader)} · ${FBP_MAP_METRICS[metric].format(fbpMapMetricValue(leader, metric))}` : "No data"}</strong></div><div><span>Lowest</span><strong>${trailer ? `${rowLabel(trailer)} · ${FBP_MAP_METRICS[metric].format(fbpMapMetricValue(trailer, metric))}` : "No data"}</strong></div>`;
  const metricDefinition = FBP_MAP_METRICS[metric];
  document.getElementById("fbp-map-legend-low").textContent = metricDefinition.low;
  document.getElementById("fbp-map-legend-high").textContent = metricDefinition.high;
  document.getElementById("fbp-map-footnote").textContent = visitorMode ? "Approximate network-location aggregates from the private analytics Sheet. No browser location permission, IP addresses, or anonymous IDs are included." : "Pool lenses use current team markets. Weather and stadium lenses use every archived physical venue.";
  const shouldFit = !fbpMapSelectedTeam;
  if (shouldFit && rowsWithValues.length) fbpMap.fitBounds(L.latLngBounds(rowsWithValues.map(row => [row.market.lat, row.market.lng])), { padding: [28, 28], maxZoom: visitorMode ? 12 : 4 });
  if (fbpMapSelectedTeam && rowsWithValues.some(row => fbpMapRowKey(row) === fbpMapSelectedTeam)) fbpMapRenderDetail(rowsWithValues.find(row => fbpMapRowKey(row) === fbpMapSelectedTeam), metric);
  else if (leader) { fbpMapSelectedTeam = fbpMapRowKey(leader); fbpMapRenderDetail(leader, metric); }
  else document.getElementById("fbp-map-detail").innerHTML = `<p class="fbp-map-empty">No mapped data is available for this selection.</p>`;
  if (visitorMode) { const forecast = document.getElementById("fbp-map-forecast"); forecast.hidden = true; forecast.innerHTML = ""; }
  else fbpMapRenderForecast();
  setTimeout(() => fbpMap.invalidateSize(), 0);
}

async function initFbpMap() {
  if (fbpMapReady) { fbpMapRender(); return; }
  const canvas = document.getElementById("fbp-map-canvas");
  if (!canvas || typeof L === "undefined") return;
  try {
    await loadDrilldown();
    buildTeamsAnalytics();
    fbpMapVisitorData = await fetch(`./data/visitor_geography.json?v=${Date.now()}`).then(response => response.ok ? response.json() : Promise.reject(new Error("Visitor export unavailable"))).catch(() => ({ updatedAt: "", locations: [] }));
  } catch (error) {
    document.getElementById("fbp-map-detail").innerHTML = `<p class="fbp-map-empty">Map data could not be loaded. ${websiteEscapeHtml(error.message)}</p>`;
    return;
  }
  const seasonSelect = document.getElementById("fbp-map-season");
  seasonSelect.innerHTML = `<option value="all">All seasons</option>${[...websiteSeasons].reverse().map(season => `<option value="${websiteEscapeHtml(season.seasonId)}">${websiteEscapeHtml(season.season)}</option>`).join("")}`;
  seasonSelect.value = "all";
  ["fbp-map-season", "fbp-map-metric", "fbp-map-division", "fbp-map-region"].forEach(id => document.getElementById(id).addEventListener("change", () => { fbpMapSelectedTeam = ""; fbpMapRender(); }));
  document.getElementById("fbp-map-basemap").addEventListener("change", event => fbpMapSetBasemap(event.target.value));
  fbpMap = L.map(canvas, { zoomControl: true, minZoom: 1, maxZoom: 16 }).setView([38.2, -96.2], 4);
  fbpMapSetBasemap(document.getElementById("fbp-map-basemap").value);
  fbpMapMarkers = L.layerGroup().addTo(fbpMap);
  fbpMapReady = true;
  fbpMapRender();
}
