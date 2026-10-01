import { getPlatformProxy } from 'wrangler';
import { fileURLToPath } from 'node:url';
import { espnEventId, fetchEspnGame, parseEspnGame } from '../src/espn.ts';

const proxy = await getPlatformProxy({
  configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)),
  persist: false,
  remoteBindings: true,
});

try {
  const game = await proxy.env.DB.prepare(
    `SELECT games.id, external_id, kickoff_at, favorite, underdog, home_team, away_team, metadata_json
     FROM games JOIN weeks ON weeks.id=games.week_id
     WHERE weeks.season=2026 AND weeks.week=4 AND weeks.phase='REGULAR_SEASON'
     ORDER BY games.game_index LIMIT 1`,
  ).first();
  if (!game) throw new Error('Week 4 opener was not found.');
  const storedGame = {
    id: Number(game.id), externalId: String(game.external_id), kickoffAt: String(game.kickoff_at),
    favorite: String(game.favorite), underdog: String(game.underdog), homeTeam: String(game.home_team),
    awayTeam: String(game.away_team), metadata: JSON.parse(String(game.metadata_json || '{}')),
  };
  const eventId = espnEventId(storedGame);
  if (!eventId) throw new Error('Week 4 opener does not have an ESPN event ID.');
  const parsed = parseEspnGame(await fetchEspnGame(eventId), storedGame);
  console.log(JSON.stringify({ ok: true, eventId, state: parsed.state, status: parsed.status, statusText: parsed.statusText, homeScore: parsed.homeScore, awayScore: parsed.awayScore, combinedNetPassingYards: parsed.combinedNetPassingYards }));
} finally {
  await proxy.dispose();
}