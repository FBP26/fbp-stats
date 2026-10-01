import { getPlatformProxy } from 'wrangler';
import { fileURLToPath } from 'node:url';

const SEASON = 2026;
const WEEK = 4;
const SCHEDULE_URL = `https://cdn.espn.com/core/nfl/schedule?xhr=1&year=${SEASON}&week=${WEEK}&seasontype=2`;
const proxy = await getPlatformProxy({
  configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)),
  persist: false,
  remoteBindings: true,
});

const normalizeTeam = value => ({ JAC: 'JAX', LA: 'LAR', WSH: 'WAS' }[String(value || '').trim().toUpperCase()] || String(value || '').trim().toUpperCase());

const scheduleEvents = payload => Object.values(payload?.content?.schedule || {})
  .flatMap(group => Array.isArray(group?.games) ? group.games : [])
  .map(event => {
    const competition = event?.competitions?.[0] || {};
    const competitors = Array.isArray(competition.competitors) ? competition.competitors : [];
    const home = competitors.find(team => team.homeAway === 'home') || {};
    const away = competitors.find(team => team.homeAway === 'away') || {};
    const eventId = String(event?.id || competition?.id || event?.uid || '').match(/\d{6,}$/)?.[0] || '';
    return {
      eventId,
      kickoff: String(event?.date || competition?.date || ''),
      home: normalizeTeam(home?.team?.abbreviation),
      away: normalizeTeam(away?.team?.abbreviation),
      venue: competition?.venue?.fullName || '',
      venueCity: competition?.venue?.address?.city || '',
      venueState: competition?.venue?.address?.state || '',
      indoor: competition?.venue?.indoor === true,
      broadcast: (competition?.broadcasts?.[0]?.names || [competition?.broadcast]).filter(Boolean).join(', '),
    };
  })
  .filter(event => event.eventId && event.home && event.away && event.kickoff);

try {
  const response = await fetch(SCHEDULE_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`ESPN Week ${WEEK} schedule returned HTTP ${response.status}.`);
  const events = scheduleEvents(await response.json());
  if (events.length !== 16) throw new Error(`Expected 16 ESPN Week ${WEEK} events, found ${events.length}.`);

  const db = proxy.env.DB;
  const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first();
  const week = await db.prepare("SELECT * FROM weeks WHERE season=? AND week=? AND phase='REGULAR_SEASON'").bind(SEASON, WEEK).first();
  if (control?.owner !== 'D1' || !week || week.status !== 'open') throw new Error('Week 4 is not the expected open D1 week.');

  const games = (await db.prepare('SELECT id,external_id,kickoff_at,home_team,away_team,metadata_json FROM games WHERE week_id=? ORDER BY game_index').bind(week.id).all()).results;
  if (games.length !== 16) throw new Error(`Expected 16 approved D1 games, found ${games.length}.`);

  const matches = games.map(game => {
    const home = normalizeTeam(game.home_team);
    const away = normalizeTeam(game.away_team);
    const kickoff = new Date(String(game.kickoff_at)).getTime();
    const event = events.find(candidate => candidate.home === home && candidate.away === away && new Date(candidate.kickoff).getTime() === kickoff);
    if (!event) throw new Error(`No exact ESPN match for ${away} at ${home} at ${game.kickoff_at}.`);
    return { game, event };
  });
  if (new Set(matches.map(match => match.event.eventId)).size !== games.length) throw new Error('ESPN matching produced duplicate event IDs.');

  const guard = 'EXISTS(SELECT 1 FROM admin_control WHERE id=1 AND owner=? AND epoch=?) AND EXISTS(SELECT 1 FROM weeks WHERE id=? AND status=?)';
  const statements = matches.map(({ game, event }) => {
    const metadata = JSON.parse(String(game.metadata_json || '{}'));
    const enriched = { ...metadata, espnEventId: event.eventId, venue: event.venue, venueCity: event.venueCity, venueState: event.venueState, indoor: event.indoor, broadcast: event.broadcast };
    return db.prepare(`UPDATE games SET metadata_json=? WHERE id=? AND ${guard}`).bind(JSON.stringify(enriched), game.id, control.owner, control.epoch, week.id, week.status);
  });
  const outcome = await db.batch(statements);
  if (outcome.some(result => result.meta.changes !== 1)) throw new Error('An ownership or week-status guard rejected metadata enrichment.');
  console.log(JSON.stringify({ ok: true, season: SEASON, week: WEEK, enriched: matches.map(({ game, event }) => ({ externalId: game.external_id, espnEventId: event.eventId, away: event.away, home: event.home, venue: event.venue })) }, null, 2));
} finally {
  await proxy.dispose();
}