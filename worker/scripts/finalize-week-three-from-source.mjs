import { getPlatformProxy } from 'wrangler';
import { fileURLToPath } from 'node:url';
import { finalizeWeek } from '../src/index.ts';

const sourceUrl = 'https://script.google.com/macros/s/AKfycbxZUgJm6LstCEomhmrlJYa_nH7tsmxC_4UZwYdroIZbs-PeI6KdPqUZtsF9fZvr_YuNWQ/exec?action=current-week';
const proxy = await getPlatformProxy({ configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)), persist: false, remoteBindings: true });

try {
  const source = await (await fetch(sourceUrl, { headers: { Accept: 'application/json' } })).json();
  if (!source?.ok || source.season !== 2026 || source.week !== 3 || !Array.isArray(source.favorites) || source.favorites.length !== 16
    || !Array.isArray(source.underdogs) || !Array.isArray(source.favoriteScores) || !Array.isArray(source.underdogScores)
    || !Number.isFinite(Number(source.actualTiebreaker))) throw new Error('Completed Week 3 source payload is incomplete.');
  const db = proxy.env.DB;
  const control = await db.prepare("SELECT owner,epoch FROM admin_control WHERE id=1").first();
  const week = await db.prepare("SELECT * FROM weeks WHERE season=2026 AND week=3 AND phase='REGULAR_SEASON'").first();
  if (control?.owner !== 'D1' || !week || !['staged', 'finalizing'].includes(week.status)) throw new Error('Week 3 is not in the expected D1 finalization state.');
  const games = (await db.prepare('SELECT id,game_index,favorite,underdog FROM games WHERE week_id=? ORDER BY game_index').bind(week.id).all()).results;
  if (games.length !== 16 || games.some((game, index) => String(game.favorite).toUpperCase() !== String(source.favorites[index]).toUpperCase()
    || String(game.underdog).toUpperCase() !== String(source.underdogs[index]).toUpperCase()
    || !Number.isFinite(Number(source.favoriteScores[index])) || !Number.isFinite(Number(source.underdogScores[index])))) throw new Error('Source results do not match the approved D1 Week 3 slate.');
  await db.batch([
    ...games.map((game, index) => db.prepare("INSERT INTO game_states (game_id,state,favorite_score,underdog_score,source_updated_at,updated_at) VALUES (?,'FINAL',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(game_id) DO UPDATE SET state='FINAL',favorite_score=excluded.favorite_score,underdog_score=excluded.underdog_score,source_updated_at=excluded.source_updated_at,updated_at=excluded.updated_at")
      .bind(game.id, Number(source.favoriteScores[index]), Number(source.underdogScores[index]))),
    db.prepare("UPDATE weeks SET status='finalizing',tiebreak_actual=? WHERE id=? AND status IN ('staged','finalizing')").bind(Number(source.actualTiebreaker), week.id),
  ]);
  const finalizing = await db.prepare('SELECT * FROM weeks WHERE id=?').bind(week.id).first();
  if (!await finalizeWeek(db, finalizing)) throw new Error('D1 archive finalization did not commit.');
  console.log(JSON.stringify({ ok: true, season: 2026, week: 3, tiebreakActual: Number(source.actualTiebreaker), archived: true }));
} finally {
  await proxy.dispose();
}