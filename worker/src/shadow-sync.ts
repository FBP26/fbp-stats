type SourcePayload = Record<string, unknown>;

export async function synchronizeShadowCards(db: D1Database, current: SourcePayload, observedAt: number): Promise<void> {
  if (current.ok !== true || !Number.isInteger(current.season) || !Number.isInteger(current.week)
    || Number(current.week) < 1 || Number(current.week) > 18
    || !Number.isSafeInteger(observedAt) || observedAt <= 0
    || !Array.isArray(current.games) || !current.games.length || !Array.isArray(current.players)) {
    throw new Error('Shadow sync requires a complete regular-season observation.');
  }
  const season = Number(current.season), week = Number(current.week);
  const games = current.games as SourcePayload[];
  const seen = new Set<string>();
  const cards = await Promise.all(current.players.map(async (player: SourcePayload) => {
    const name = String(player.name || '').trim();
    const playerKey = name.toLowerCase();
    const picks = Array.isArray(player.picks) ? player.picks.map(pick => String(pick).trim().toUpperCase()) : [];
    const bestBet = String(player.bestBet || '').trim().toUpperCase();
    const teams = (game: SourcePayload): string[] => [String(game.favorite || '').toUpperCase(), String(game.underdog || '').toUpperCase()];
    if (!name || seen.has(playerKey) || picks.length !== games.length
      || picks.some((pick, index) => !pick || !teams(games[index]).includes(pick))
      || !bestBet || !games.some(game => teams(game).includes(bestBet))
      || player.tiebreaker === '' || player.tiebreaker == null
      || !Number.isFinite(Number(player.tiebreaker)) || Number(player.tiebreaker) < -100 || Number(player.tiebreaker) > 1200) {
      throw new Error('Shadow sync rejected a duplicate or invalid player card.');
    }
    seen.add(playerKey);
    const submittedAt = player.submittedAt == null || player.submittedAt === '' ? null : new Date(String(player.submittedAt)).toISOString();
    const card = {
      name, weekName: String(player.weekName || ''), picks, bestBet,
      tiebreaker: Number(player.tiebreaker), submittedAt,
      gameIds: games.map(game => String(game.gameId || '')),
    };
    if (card.gameIds.some(gameId => !gameId) || new Set(card.gameIds).size !== games.length) {
      throw new Error('Shadow sync requires unique source game IDs.');
    }
    const cardJson = JSON.stringify(card);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cardJson));
    const contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return { playerKey, contentHash, revisionId: `${observedAt}:${contentHash}`, cardJson, submittedAt };
  }));
  const encodedCards = JSON.stringify(cards);
  const newerObservation = `NOT EXISTS (SELECT 1 FROM shadow_sync_weeks
    WHERE season = ? AND week = ? AND observed_at >= ?)`;
  await db.batch([
    db.prepare(`INSERT INTO shadow_card_revisions
      (season, week, player_key, revision_id, content_hash, observed_at, submitted_at, card_json)
      SELECT ?, ?, json_extract(card.value, '$.playerKey'), json_extract(card.value, '$.revisionId'),
        json_extract(card.value, '$.contentHash'), ?, json_extract(card.value, '$.submittedAt'), json_extract(card.value, '$.cardJson')
      FROM json_each(?) AS card WHERE ${newerObservation}
        AND NOT EXISTS (SELECT 1 FROM shadow_card_heads WHERE season = ? AND week = ?
          AND player_key = json_extract(card.value, '$.playerKey') AND content_hash = json_extract(card.value, '$.contentHash'))
      ON CONFLICT DO NOTHING`)
      .bind(season, week, observedAt, encodedCards, season, week, observedAt, season, week),
    db.prepare(`INSERT INTO shadow_card_heads (season, week, player_key, revision_id, content_hash, observed_at)
      SELECT ?, ?, json_extract(card.value, '$.playerKey'), json_extract(card.value, '$.revisionId'),
        json_extract(card.value, '$.contentHash'), ? FROM json_each(?) AS card
      WHERE ${newerObservation} AND EXISTS (SELECT 1 FROM shadow_card_revisions
        WHERE season = ? AND week = ? AND player_key = json_extract(card.value, '$.playerKey')
          AND revision_id = json_extract(card.value, '$.revisionId'))
      ON CONFLICT (season, week, player_key) DO UPDATE SET revision_id = excluded.revision_id,
        content_hash = excluded.content_hash, observed_at = excluded.observed_at
      WHERE excluded.observed_at > shadow_card_heads.observed_at`)
      .bind(season, week, observedAt, encodedCards, season, week, observedAt, season, week),
    db.prepare(`INSERT INTO shadow_sync_weeks (season, week, observed_at, source_updated_at, members_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (season, week) DO UPDATE SET
      observed_at = excluded.observed_at, source_updated_at = excluded.source_updated_at, members_json = excluded.members_json
      WHERE excluded.observed_at > shadow_sync_weeks.observed_at`)
      .bind(season, week, observedAt, String(current.updatedAt || ''), JSON.stringify([...seen].sort())),
  ]);
}