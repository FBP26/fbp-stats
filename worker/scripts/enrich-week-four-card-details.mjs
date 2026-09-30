import { getPlatformProxy } from 'wrangler';
import { fileURLToPath } from 'node:url';

const SEASON = 2026;
const WEEK = 4;
const proxy = await getPlatformProxy({
  configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)),
  persist: false,
  remoteBindings: true,
});

const normalizedTeam = value => ({ JAC: 'JAX', LA: 'LAR', WSH: 'WAS' }[String(value || '').trim().toUpperCase()] || String(value || '').trim().toUpperCase());
const recordFor = competitor => (competitor?.record || []).find(record => record.type === 'total')?.displayValue || '';
const weatherLabel = code => ({
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Foggy', 48: 'Icy fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Heavy rain showers',
  82: 'Violent rain showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorms',
  96: 'Thunderstorms with hail', 99: 'Severe thunderstorms with hail',
}[Number(code)] || 'Forecast unavailable');

const espnDetails = async game => {
  const eventId = String(game.metadata.espnEventId || '');
  if (!eventId) throw new Error(`${game.external_id} is missing espnEventId.`);
  const response = await fetch(`https://cdn.espn.com/core/nfl/game?xhr=1&gameId=${encodeURIComponent(eventId)}`);
  if (!response.ok) throw new Error(`ESPN event ${eventId} returned HTTP ${response.status}.`);
  const competition = (await response.json())?.gamepackageJSON?.header?.competitions?.[0];
  const home = competition?.competitors?.find(team => team.homeAway === 'home');
  const away = competition?.competitors?.find(team => team.homeAway === 'away');
  if (normalizedTeam(home?.team?.abbreviation) !== normalizedTeam(game.home_team) || normalizedTeam(away?.team?.abbreviation) !== normalizedTeam(game.away_team)) {
    throw new Error(`ESPN event ${eventId} does not match ${game.away_team} at ${game.home_team}.`);
  }
  return { awayRecord: recordFor(away), homeRecord: recordFor(home) };
};

const outdoorForecast = async (metadata, kickoff) => {
  const city = String(metadata.venueCity || '').trim();
  const state = String(metadata.venueState || '').trim();
  if (!city) throw new Error(`No venue city is available for ${metadata.venue || 'an outdoor game'}.`);
  const place = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`)).json();
  const location = place?.results?.[0];
  if (!location || !Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude))) throw new Error(`Open-Meteo could not locate ${city}${state ? `, ${state}` : ''}.`);
  const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(location.latitude)}&longitude=${encodeURIComponent(location.longitude)}&hourly=temperature_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT&forecast_days=7`;
  const forecast = await (await fetch(forecastUrl)).json();
  const hours = forecast?.hourly?.time || [];
  const target = new Date(kickoff).getTime();
  const index = hours.reduce((best, hour, current) => Math.abs(new Date(`${hour}Z`).getTime() - target) < Math.abs(new Date(`${hours[best]}Z`).getTime() - target) ? current : best, 0);
  return {
    temperature: Math.round(Number(forecast.hourly.temperature_2m[index])),
    weather: weatherLabel(forecast.hourly.weather_code[index]),
    windMph: Math.round(Number(forecast.hourly.wind_speed_10m[index])),
    weatherSource: 'Open-Meteo forecast',
  };
};

try {
  const db = proxy.env.DB;
  const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first();
  const week = await db.prepare("SELECT * FROM weeks WHERE season=? AND week=? AND phase='REGULAR_SEASON'").bind(SEASON, WEEK).first();
  if (control?.owner !== 'D1' || !week || week.status !== 'open') throw new Error('Week 4 is not the expected open D1 week.');
  const rows = (await db.prepare('SELECT id,external_id,kickoff_at,home_team,away_team,metadata_json FROM games WHERE week_id=? ORDER BY game_index').bind(week.id).all()).results;
  if (rows.length !== 16) throw new Error(`Expected 16 Week 4 games, found ${rows.length}.`);
  const games = rows.map(row => ({ ...row, metadata: JSON.parse(String(row.metadata_json || '{}')) }));
  const details = await Promise.all(games.map(async game => {
    const records = await espnDetails(game);
    const weather = game.metadata.indoor ? { weather: 'Indoor', weatherSource: 'Venue' } : await outdoorForecast(game.metadata, game.kickoff_at);
    return { game, records, weather };
  }));
  const guard = 'EXISTS(SELECT 1 FROM admin_control WHERE id=1 AND owner=? AND epoch=?) AND EXISTS(SELECT 1 FROM weeks WHERE id=? AND status=?)';
  const outcome = await db.batch(details.map(({ game, records, weather }) => {
    const metadata = {
      ...game.metadata,
      awayTeam: { ...(game.metadata.awayTeam || {}), record: records.awayRecord },
      homeTeam: { ...(game.metadata.homeTeam || {}), record: records.homeRecord },
      ...weather,
    };
    return db.prepare(`UPDATE games SET metadata_json=? WHERE id=? AND ${guard}`).bind(JSON.stringify(metadata), game.id, control.owner, control.epoch, week.id, week.status);
  }));
  if (outcome.some(result => result.meta.changes !== 1)) throw new Error('An ownership or week-status guard rejected metadata enrichment.');
  console.log(JSON.stringify({ ok: true, enriched: details.map(({ game, records, weather }) => ({ externalId: game.external_id, ...records, ...weather })) }, null, 2));
} finally {
  await proxy.dispose();
}