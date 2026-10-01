import { adminDigest, canonicalAdminJson } from '../src/admin-store.ts';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { rehearseOperationalCheckpoint } from './operational-checkpoint.mjs';
import { parse } from 'csv-parse/sync';

export function sourceSubmissionTime(body) {
  const raw = body.submittedAtRaw;
  if (typeof raw === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(raw) && Number.isFinite(Date.parse(raw))) return new Date(raw).toISOString();
  if (typeof raw !== 'number' || !Number.isFinite(raw) || body.timeZone !== 'America/New_York') throw new Error('Original submission timestamp is missing or unsupported.');
  const wall = Date.UTC(1899, 11, 30) + Math.round(raw * 86400000);
  const desired = new Date(wall).toISOString().slice(0, 19);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: body.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const matches = [4, 5].map(offset => wall + offset * 3600000).filter(value => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` === desired;
  });
  if (matches.length !== 1) throw new Error('Original submission timestamp has an ambiguous or invalid Eastern offset.');
  return new Date(matches[0]).toISOString();
}

export function parseCompletedArchive(csv) {
  const rows = parse(csv, { columns: true, bom: true, skip_empty_lines: true });
  if (!rows.length || !/^20\d{2}-20\d{2}$/.test(rows[0].Season)) throw new Error('Invalid completed archive season.');
  const season = Number(rows[0].Season.slice(0, 4)), week = Number(rows[0].Week);
  if (rows[0].Season !== `${season}-${season + 1}` || !Number.isInteger(week) || week < 1 || week > 18) throw new Error('Invalid completed archive week.');
  const numeric = (value, label) => {
    if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error(`Missing or invalid archive ${label}.`);
    return Number(value);
  };
  const actualTiebreaker = numeric(rows[0]['Actual Tiebreak'], 'final tiebreaker');
  const gameRows = new Map(), players = new Map();
  const gameFields = ['Game Date', 'Game Time', 'Favorite', 'Underdog', 'Spread', 'Home', 'Away', 'Fav Score', 'Und Score'];
  for (const row of rows) {
    const index = numeric(row['Game Num'], 'game number') - 1;
    if (row.Season !== `${season}-${season + 1}` || Number(row.Week) !== week || !Number.isInteger(index) || index < 0 || index >= 16
      || numeric(row['Actual Tiebreak'], 'final tiebreaker') !== actualTiebreaker) throw new Error('Mixed or invalid completed archive rows.');
    if (gameRows.has(index) && gameFields.some(field => row[field] !== gameRows.get(index)[field])) throw new Error('Conflicting completed archive game rows.');
    gameRows.set(index, row);
    const name = String(row.Name || '').trim();
    if (!name) throw new Error('Missing completed archive player.');
    const key = name.toLowerCase();
    const player = players.get(key) || { name, weekName: row['Week Name'], bestBet: row['Best Bet'], tiebreaker: numeric(row.Tiebreaker, 'player tiebreaker'), picks: [] };
    if (player.picks[index] !== undefined || player.weekName !== row['Week Name'] || player.bestBet !== row['Best Bet'] || player.tiebreaker !== Number(row.Tiebreaker)) throw new Error('Duplicate or inconsistent completed player card.');
    player.picks[index] = row.Pick;
    players.set(key, player);
  }
  const games = [...gameRows].sort(([left], [right]) => left - right).map(([index, row], position) => {
    const date = row['Game Date'].match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const timeText = String(row['Game Time'] || '').trim();
    const time = timeText.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (index !== position || !date || (timeText && (!time || Number(time[1]) < 1 || Number(time[1]) > 12 || Number(time[2]) > 59))) throw new Error('Invalid completed archive kickoff or order.');
    const wall = Date.UTC(Number(date[3]), Number(date[1]) - 1, Number(date[2]), time ? Number(time[1]) % 12 + (time[3].toUpperCase() === 'PM' ? 12 : 0) : 0, time ? Number(time[2]) : 0);
    const parsedDate = new Date(wall);
    if (parsedDate.getUTCMonth() + 1 !== Number(date[1]) || parsedDate.getUTCDate() !== Number(date[2]) || ![season, season + 1].includes(Number(date[3]))) throw new Error('Invalid completed archive date.');
    const favorite = row.Favorite, underdog = row.Underdog, home = row.Home.toUpperCase(), away = row.Away.toUpperCase();
    if (!/^[A-Za-z]{2,4}$/.test(favorite) || !/^[A-Za-z]{2,4}$/.test(underdog) || favorite.toUpperCase() === underdog.toUpperCase() || home === away
      || ![favorite.toUpperCase(), underdog.toUpperCase()].includes(home) || ![favorite.toUpperCase(), underdog.toUpperCase()].includes(away)) throw new Error('Invalid completed archive matchup.');
    const favoriteScore = numeric(row['Fav Score'], 'favorite score'), underdogScore = numeric(row['Und Score'], 'underdog score');
    if (![favoriteScore, underdogScore].every(score => Number.isInteger(score) && score >= 0)) throw new Error('Invalid completed archive final score.');
    return { gameId: `archive-${season}-${week}-${index + 1}`, gameDate: row['Game Date'], kickoffPrecision: time ? 'minute' : 'date',
      kickoff: time ? sourceSubmissionTime({ submittedAtRaw: (wall - Date.UTC(1899, 11, 30)) / 86400000, timeZone: 'America/New_York' }) : null,
      favorite, underdog, home, away, spread: numeric(row.Spread, 'spread'), favoriteScore, underdogScore,
      homeScore: home === favorite.toUpperCase() ? favoriteScore : underdogScore, awayScore: away === favorite.toUpperCase() ? favoriteScore : underdogScore, status: 'FINAL' };
  });
  const cards = [...players.values()];
  for (const player of cards) {
    if (player.picks.length !== games.length || games.some((game, index) => ![game.favorite, game.underdog].includes(player.picks[index]))
      || !games.some(game => [game.favorite, game.underdog].includes(player.bestBet))) throw new Error('Incomplete completed archive card.');
  }
  return { season, week, actualTiebreaker, games, cards };
}

export async function importCompletedOperationalSlate(db, csv, { apply = false } = {}) {
  const archive = parseCompletedArchive(csv);
  const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first();
  if (control?.owner !== 'SHEETS') throw new Error('Completed slate imports require Sheets ownership.');
  const records = (await db.prepare("SELECT record_id,version,body FROM admin_records WHERE kind='submission'").all()).results
    .filter(record => { const body = JSON.parse(record.body); return body.season === `${archive.season}-${archive.season + 1}` && body.week === archive.week; });
  const submissions = records.map(record => {
    const body = JSON.parse(record.body);
    if (record.version !== 1 || !record.record_id.startsWith('submission:')) throw new Error('Edited source submissions require reconciliation.');
    return { name: body.name.trim(), weekName: body.weekName, picks: body.picks, bestBet: body.bestBet, tiebreaker: body.tiebreaker,
      submittedAt: sourceSubmissionTime(body), season: body.season, week: body.week, phase: 'REGULAR_SEASON', source: 'source-original' };
  }).sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  const latest = new Map(submissions.map(card => [card.name.toLowerCase(), card]));
  if (latest.size !== archive.cards.length || archive.cards.some(card => {
    const original = latest.get(card.name.toLowerCase());
    return !original || original.weekName !== card.weekName || original.tiebreaker !== card.tiebreaker
      || original.bestBet.toUpperCase() !== card.bestBet.toUpperCase()
      || canonicalAdminJson(original.picks.map(pick => pick.toUpperCase())) !== canonicalAdminJson(card.picks.map(pick => pick.toUpperCase()));
  })) throw new Error('Completed archive and original cards disagree; no slate was imported.');
  const checksum = await adminDigest(csv), operationId = `completed-slate:${checksum}`, recordId = `completed-slate:${archive.season}:${archive.week}`;
  const prior = await db.prepare('SELECT request_hash FROM admin_events WHERE operation_id=?').bind(operationId).first();
  const verify = async () => {
    const saved = await db.prepare("SELECT weeks.id,weeks.status,weeks.tiebreak_actual,completed_week_archives.payload_json,completed_week_archives.checksum FROM weeks JOIN completed_week_archives ON week_id=weeks.id WHERE season=? AND week=? AND phase='REGULAR_SEASON'").bind(archive.season, archive.week).first();
    if (!saved || saved.status !== 'finalized' || saved.tiebreak_actual !== archive.actualTiebreaker || await adminDigest(saved.payload_json) !== saved.checksum) throw new Error('Completed slate archive verification failed.');
    const payload = JSON.parse(saved.payload_json);
    const games = (await db.prepare('SELECT game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team,state,favorite_score,underdog_score FROM games JOIN game_states ON game_id=games.id WHERE week_id=? ORDER BY game_index').bind(saved.id).all()).results;
    if (payload.sourceChecksum !== checksum || canonicalAdminJson(payload.games) !== canonicalAdminJson(archive.games) || canonicalAdminJson(payload.submissions) !== canonicalAdminJson(submissions)
      || games.length !== archive.games.length || games.some((game, index) => {
        const expected = archive.games[index];
        return game.game_index !== index || game.external_id !== expected.gameId || game.kickoff_at !== (expected.kickoff || '')
          || game.favorite !== expected.favorite || game.underdog !== expected.underdog || game.spread !== expected.spread
          || game.home_team !== expected.home || game.away_team !== expected.away || game.state !== 'FINAL'
          || game.favorite_score !== expected.favoriteScore || game.underdog_score !== expected.underdogScore;
      })) throw new Error('Completed slate no longer matches its immutable source.');
  };
  if (prior) {
    if (prior.request_hash !== checksum) throw new Error('Completed slate receipt conflict.');
    await verify();
    return { season: archive.season, week: archive.week, inserted: 0, replayed: true };
  }
  if (await db.prepare("SELECT id FROM weeks WHERE season=? AND week=? AND phase='REGULAR_SEASON'").bind(archive.season, archive.week).first()) throw new Error('Existing operational slate requires reconciliation; nothing was overwritten.');
  if (!apply) return { season: archive.season, week: archive.week, games: archive.games.length, cards: submissions.length, safe: true, productionWrites: 0 };
  const now = new Date().toISOString();
  const evidence = canonicalAdminJson({ csvSha256: checksum, season: archive.season, week: archive.week, importedAt: now });
  const payload = JSON.stringify({ ok: true, archivedAt: now, archiveSource: 'completed-csv', sourceChecksum: checksum, season: `${archive.season}-${archive.season + 1}`,
    seasonStart: archive.season, week: archive.week, phase: 'REGULAR_SEASON', actualTiebreaker: archive.actualTiebreaker, games: archive.games, submissions });
  const present = 'EXISTS(SELECT 1 FROM admin_events WHERE operation_id=?)';
  const weekQuery = "SELECT id FROM weeks WHERE season=? AND week=? AND phase='REGULAR_SEASON'";
  await db.batch([
    db.prepare(`INSERT INTO admin_events(operation_id,request_hash,kind,record_id,version,epoch,actor,reason,recorded_at,body)
      SELECT ?,?,'source-ledger',?,1,?,'source-import','Import immutable completed CSV slate with preserved submission times',?,?
      WHERE EXISTS(SELECT 1 FROM admin_control WHERE owner='SHEETS' AND epoch=?) AND NOT EXISTS(${weekQuery})
      AND (SELECT count(*) FROM admin_records WHERE kind='submission' AND json_extract(body,'$.season')=? AND json_extract(body,'$.week')=?)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) original WHERE NOT EXISTS(SELECT 1 FROM admin_records WHERE kind='submission'
        AND record_id=json_extract(original.value,'$.record_id') AND version=1 AND body=json_extract(original.value,'$.body')))`)
      .bind(operationId, checksum, recordId, control.epoch, now, evidence, control.epoch, archive.season, archive.week, `${archive.season}-${archive.season + 1}`, archive.week, records.length, JSON.stringify(records)),
    db.prepare('INSERT INTO admin_records(kind,record_id,version,operation_id,body) SELECT kind,record_id,version,operation_id,body FROM admin_events WHERE operation_id=?').bind(operationId),
    db.prepare(`INSERT INTO weeks(season,week,phase,status,tiebreak_actual,finalized_at) SELECT ?,?,'REGULAR_SEASON','finalized',?,? WHERE ${present}`).bind(archive.season, archive.week, archive.actualTiebreaker, now, operationId),
    ...archive.games.flatMap((game, index) => [
      db.prepare(`INSERT INTO games(week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team,metadata_json) SELECT id,?,?,?,?,?,?,?,?,? FROM weeks WHERE season=? AND week=? AND phase='REGULAR_SEASON' AND ${present}`)
        .bind(index, game.gameId, game.kickoff || '', game.favorite, game.underdog, game.spread, game.home, game.away, JSON.stringify(game), archive.season, archive.week, operationId),
      db.prepare(`INSERT INTO game_states(game_id,state,favorite_score,underdog_score,source_updated_at) SELECT id,'FINAL',?,?,? FROM games WHERE week_id=(${weekQuery}) AND game_index=? AND ${present}`)
        .bind(game.favoriteScore, game.underdogScore, now, archive.season, archive.week, index, operationId),
    ]),
    db.prepare(`INSERT INTO completed_week_archives(week_id,payload_json,checksum,finalized_at) SELECT id,?,?,? FROM weeks WHERE season=? AND week=? AND phase='REGULAR_SEASON' AND ${present}`)
      .bind(payload, await adminDigest(payload), now, archive.season, archive.week, operationId),
  ]);
  if (!await db.prepare('SELECT operation_id FROM admin_events WHERE operation_id=?').bind(operationId).first()) throw new Error('Completed slate import was fenced by changed ownership or source records.');
  await verify();
  return { season: archive.season, week: archive.week, inserted: archive.games.length, sourceWrites: 0 };
}

export async function reconcileExistingCompletedOperationalSlate(db, csv, { apply = false } = {}) {
  const archive = parseCompletedArchive(csv);
  const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first();
  if (control?.owner !== 'SHEETS') throw new Error('Completed slate reconciliation requires Sheets ownership.');
  const week = await db.prepare("SELECT id,status,tiebreak_actual FROM weeks WHERE season=? AND week=? AND phase='REGULAR_SEASON'")
    .bind(archive.season, archive.week).first();
  if (!week || week.status !== 'finalized' || Number(week.tiebreak_actual) !== archive.actualTiebreaker) {
    throw new Error('A matching finalized operational slate is required.');
  }
  const checksum = await adminDigest(csv), operationId = `completed-slate-reconcile:${checksum}`, recordId = `completed-slate-reconcile:${archive.season}:${archive.week}`;
  const existingArchive = await db.prepare('SELECT payload_json,checksum FROM completed_week_archives WHERE week_id=?').bind(week.id).first();
  if (existingArchive) {
    const prior = await db.prepare('SELECT request_hash FROM admin_events WHERE operation_id=?').bind(operationId).first();
    if (!prior || prior.request_hash !== checksum || await adminDigest(existingArchive.payload_json) !== existingArchive.checksum) {
      throw new Error('The matching operational slate already has an immutable archive.');
    }
    return { season: archive.season, week: archive.week, inserted: 0, replayed: true, sourceWrites: 0 };
  }
  const games = (await db.prepare(`SELECT game_index,kickoff_at,favorite,underdog,spread,home_team,away_team,state,favorite_score,underdog_score
    FROM games JOIN game_states ON game_id=games.id WHERE week_id=? ORDER BY game_index`).bind(week.id).all()).results;
  if (games.length !== archive.games.length || games.some((game, index) => {
    const expected = archive.games[index];
    return Number(game.game_index) !== index || String(game.state) !== 'FINAL'
      || String(game.favorite).toUpperCase() !== expected.favorite.toUpperCase() || String(game.underdog).toUpperCase() !== expected.underdog.toUpperCase()
      || Number(game.spread) !== expected.spread || String(game.home_team).toUpperCase() !== expected.home.toUpperCase()
      || String(game.away_team).toUpperCase() !== expected.away.toUpperCase() || Number(game.favorite_score) !== expected.favoriteScore
      || Number(game.underdog_score) !== expected.underdogScore || (expected.kickoff && new Date(String(game.kickoff_at)).getTime() !== new Date(expected.kickoff).getTime());
  })) throw new Error('Finalized operational games disagree with canonical completed CSV.');
  const records = (await db.prepare("SELECT record_id,version,body FROM admin_records WHERE kind='submission'").all()).results
    .filter(record => { const body = JSON.parse(record.body); return body.season === `${archive.season}-${archive.season + 1}` && body.week === archive.week; });
  const originals = records.map(record => {
    const body = JSON.parse(record.body);
    if (record.version !== 1 || !record.record_id.startsWith('submission:')) throw new Error('Edited source submissions require reconciliation.');
    return { name: body.name.trim(), weekName: body.weekName, picks: body.picks, bestBet: body.bestBet, tiebreaker: body.tiebreaker,
      submittedAt: sourceSubmissionTime(body), season: body.season, week: body.week, phase: 'REGULAR_SEASON', source: 'source-original' };
  }).sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  const byName = new Map(originals.map(card => [card.name.toLowerCase(), card]));
  if (byName.size !== archive.cards.length || archive.cards.some(card => {
    const original = byName.get(card.name.toLowerCase());
    return !original || original.weekName !== card.weekName || Number(original.tiebreaker) !== card.tiebreaker
      || String(original.bestBet).toUpperCase() !== String(card.bestBet).toUpperCase()
      || canonicalAdminJson(original.picks.map(pick => String(pick).toUpperCase())) !== canonicalAdminJson(card.picks.map(pick => String(pick).toUpperCase()));
  })) throw new Error('Completed archive and preserved originals disagree; no archive was created.');
  const existing = (await db.prepare(`SELECT p.canonical_name AS name,s.week_name AS weekName,s.best_bet_team AS bestBet,s.tiebreaker,s.source,s.submitted_at AS submittedAt,
    (SELECT json_group_array(picked_team) FROM (SELECT picked_team FROM submission_picks JOIN games ON games.id=game_id
      WHERE submission_id=s.id ORDER BY game_index)) AS picks
    FROM submissions s JOIN players p ON p.id=s.player_id WHERE s.week_id=? ORDER BY s.submitted_at,s.id`).bind(week.id).all()).results
    .map(card => ({ ...card, picks: JSON.parse(String(card.picks || '[]')) }));
  if (existing.some(card => card.picks.length !== archive.games.length || card.picks.some(pick => !pick))) {
    throw new Error('Finalized operational cards are incomplete.');
  }
  const normalizeCards = cards => canonicalAdminJson(cards.map(card => ({ name: String(card.name).trim().toLowerCase(), weekName: card.weekName,
    picks: card.picks.map(pick => String(pick).toUpperCase()), bestBet: String(card.bestBet).toUpperCase(), tiebreaker: Number(card.tiebreaker),
    submittedAt: card.submittedAt, source: card.source })).sort((left, right) => left.submittedAt.localeCompare(right.submittedAt)));
  if (normalizeCards(existing) !== normalizeCards(originals)) throw new Error('Finalized operational cards disagree with preserved originals.');
  const payload = JSON.stringify({ ok: true, archivedAt: new Date().toISOString(), archiveSource: 'completed-csv-reconciliation', sourceChecksum: checksum,
    season: `${archive.season}-${archive.season + 1}`, seasonStart: archive.season, week: archive.week, phase: 'REGULAR_SEASON',
    actualTiebreaker: archive.actualTiebreaker, games: archive.games, submissions: originals });
  const prior = await db.prepare('SELECT request_hash FROM admin_events WHERE operation_id=?').bind(operationId).first();
  if (prior) {
    if (prior.request_hash !== checksum) throw new Error('Completed slate reconciliation receipt conflict.');
    const saved = await db.prepare('SELECT payload_json,checksum FROM completed_week_archives WHERE week_id=?').bind(week.id).first();
    if (!saved || await adminDigest(saved.payload_json) !== saved.checksum) throw new Error('Completed slate reconciliation verification failed.');
    return { season: archive.season, week: archive.week, inserted: 0, replayed: true, sourceWrites: 0 };
  }
  if (!apply) return { season: archive.season, week: archive.week, games: archive.games.length, cards: originals.length, safe: true, productionWrites: 0, sourceWrites: 0 };
  const now = new Date().toISOString();
  const evidence = canonicalAdminJson({ csvSha256: checksum, season: archive.season, week: archive.week, reconciledAt: now });
  await db.batch([
    db.prepare(`INSERT INTO admin_events(operation_id,request_hash,kind,record_id,version,epoch,actor,reason,recorded_at,body)
      SELECT ?,?,'source-ledger',?,1,?,'source-import','Reconcile finalized completed CSV archive without replacing operational data',?,?
      WHERE EXISTS(SELECT 1 FROM admin_control WHERE owner='SHEETS' AND epoch=?)
        AND EXISTS(SELECT 1 FROM weeks WHERE id=? AND status='finalized' AND tiebreak_actual IS ?)
        AND NOT EXISTS(SELECT 1 FROM completed_week_archives WHERE week_id=?)`)
      .bind(operationId, checksum, recordId, control.epoch, now, evidence, control.epoch, week.id, archive.actualTiebreaker, week.id),
    db.prepare('INSERT INTO admin_records(kind,record_id,version,operation_id,body) SELECT kind,record_id,version,operation_id,body FROM admin_events WHERE operation_id=?').bind(operationId),
    db.prepare(`INSERT INTO completed_week_archives(week_id,payload_json,checksum,finalized_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM admin_events WHERE operation_id=?)
        AND NOT EXISTS(SELECT 1 FROM completed_week_archives WHERE week_id=?)`)
      .bind(week.id, payload, await adminDigest(payload), now, operationId, week.id),
  ]);
  if (!await db.prepare('SELECT operation_id FROM admin_events WHERE operation_id=?').bind(operationId).first()) throw new Error('Ownership, week state, or archive presence changed; reconciliation was fenced.');
  const saved = await db.prepare('SELECT payload_json,checksum FROM completed_week_archives WHERE week_id=?').bind(week.id).first();
  if (!saved || await adminDigest(saved.payload_json) !== saved.checksum) throw new Error('Completed slate reconciliation verification failed.');
  return { season: archive.season, week: archive.week, inserted: 1, sourceWrites: 0 };
}

export async function importOperationalOriginals(db, season, weekNumber, { apply = false } = {}) {
  if (!Number.isInteger(season) || !Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 18) throw new Error('A regular-season week is required.');
  const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first();
  if (control?.owner !== 'SHEETS') throw new Error('Original imports require Sheets ownership.');
  const week = await db.prepare("SELECT id FROM weeks WHERE season=? AND week=? AND phase='REGULAR_SEASON'").bind(season, weekNumber).first();
  if (!week) throw new Error('The matching operational slate must already exist.');
  const games = (await db.prepare('SELECT id,game_index,favorite,underdog,kickoff_at FROM games WHERE week_id=? ORDER BY game_index').bind(week.id).all()).results;
  if (!games.length || games.some((game, index) => game.game_index !== index)) throw new Error('Operational slate order is incomplete.');
  const records = (await db.prepare("SELECT record_id,version,body FROM admin_records WHERE kind='submission' ORDER BY record_id").all()).results
    .filter(record => { const body = JSON.parse(record.body); return body.season === `${season}-${season + 1}` && body.week === weekNumber; });
  if (!records.length) throw new Error('No preserved originals for this week.');
  const cards = records.map(record => {
    const body = JSON.parse(record.body);
    if (!record.record_id.startsWith('submission:') || record.version !== 1 || !body.provenance?.ledgerChecksum || !body.name?.trim() || !Array.isArray(body.picks)
      || body.picks.length !== games.length || body.tiebreaker == null || body.tiebreaker === '' || !Number.isFinite(Number(body.tiebreaker))) throw new Error('Original identity, source version, or card is incomplete.');
    const picks = body.picks.map((pick, index) => {
      const team = [games[index].favorite, games[index].underdog].find(team => team.toUpperCase() === String(pick).toUpperCase());
      if (!team) throw new Error('Original picks do not match the operational slate.');
      return team;
    });
    const bestBetIndex = games.findIndex(game => [game.favorite, game.underdog].some(team => team.toUpperCase() === String(body.bestBet).toUpperCase()));
    if (bestBetIndex < 0) throw new Error('Original Best Bet is not on the slate.');
    const bestBet = [games[bestBetIndex].favorite, games[bestBetIndex].underdog].find(team => team.toUpperCase() === String(body.bestBet).toUpperCase());
    return { recordId: record.record_id, sourceVersion: record.version, sourceBody: record.body, name: body.name.trim(), submittedName: body.name,
      weekName: body.weekName, picks, bestBet, bestBetIndex, tiebreaker: Number(body.tiebreaker), submittedAt: sourceSubmissionTime(body), supersededAt: null };
  });
  cards.sort((left, right) => left.name.toLowerCase().localeCompare(right.name.toLowerCase()) || left.submittedAt.localeCompare(right.submittedAt));
  for (let index = 0; index < cards.length - 1; index++) {
    if (cards[index].name.toLowerCase() !== cards[index + 1].name.toLowerCase()) continue;
    if (cards[index].submittedAt === cards[index + 1].submittedAt) throw new Error('Ambiguous originals share the same player and timestamp.');
    cards[index].supersededAt = cards[index + 1].submittedAt;
  }
  const encoded = canonicalAdminJson(cards), slate = canonicalAdminJson(games);
  const hash = await adminDigest(canonicalAdminJson({ season, weekNumber, cards, games }));
  const operationId = `original-map:${hash}`, recordId = `original-map:${season}:${weekNumber}`;
  const receipt = await db.prepare('SELECT request_hash FROM admin_events WHERE operation_id=?').bind(operationId).first();
  const verify = async () => {
    const stored = (await db.prepare(`SELECT links.record_id,s.submitted_at,s.superseded_at,s.week_name,s.best_bet_team,s.tiebreaker,p.canonical_name,
      (SELECT json_group_array(picked_team) FROM (SELECT picked_team FROM submission_picks JOIN games ON games.id=game_id WHERE submission_id=s.id ORDER BY game_index)) AS picks
      FROM submissions s JOIN players p ON p.id=s.player_id JOIN admin_submission_links links ON links.submission_id=s.id WHERE s.week_id=?`).bind(week.id).all()).results;
    if (stored.length !== cards.length || cards.some(card => {
      const saved = stored.find(row => row.record_id === card.recordId);
      return !saved || saved.submitted_at !== card.submittedAt || saved.superseded_at !== card.supersededAt || saved.week_name !== card.weekName
        || saved.best_bet_team !== card.bestBet || saved.tiebreaker !== card.tiebreaker || saved.canonical_name.toLowerCase() !== card.name.toLowerCase()
        || JSON.stringify(JSON.parse(saved.picks)) !== JSON.stringify(card.picks);
    })) throw new Error('Operational original mapping does not match preserved source cards.');
  };
  if (receipt) {
    if (receipt.request_hash !== hash) throw new Error('Original import receipt mismatch.');
    await verify();
    return { season, week: weekNumber, cards: cards.length, inserted: 0, verified: true, sourceWrites: 0 };
  }
  const existing = await db.prepare('SELECT count(*) AS total FROM submissions WHERE week_id=?').bind(week.id).first();
  if (existing.total) throw new Error('Existing operational cards require explicit reconciliation; no originals were overwritten.');
  if (!apply) return { season, week: weekNumber, cards: cards.length, safe: true, productionWrites: 0, sourceWrites: 0 };
  const evidence = canonicalAdminJson({ season, week: weekNumber, cards: cards.length, sha256: hash, sourceRecordIds: cards.map(card => card.recordId) });
  const present = 'EXISTS(SELECT 1 FROM admin_events WHERE operation_id=?)';
  await db.batch([
    db.prepare(`INSERT INTO admin_events(operation_id,request_hash,kind,record_id,version,epoch,actor,reason,recorded_at,body)
      SELECT ?,?,'source-ledger',?,1,?,'source-import','Map preserved originals without source changes',?,?
      WHERE EXISTS(SELECT 1 FROM admin_control WHERE owner='SHEETS' AND epoch=?)
      AND NOT EXISTS(SELECT 1 FROM submissions WHERE week_id=?)
      AND NOT EXISTS(SELECT 1 FROM json_each(?) card WHERE NOT EXISTS(SELECT 1 FROM admin_records WHERE kind='submission'
        AND record_id=json_extract(card.value,'$.recordId') AND version=json_extract(card.value,'$.sourceVersion') AND body=json_extract(card.value,'$.sourceBody')))
      AND (SELECT json_group_array(json_object('favorite',favorite,'game_index',game_index,'id',id,'kickoff_at',kickoff_at,'underdog',underdog)) FROM (SELECT * FROM games WHERE week_id=? ORDER BY game_index))=?`)
      .bind(operationId, hash, recordId, control.epoch, new Date().toISOString(), evidence, control.epoch, week.id, encoded, week.id, slate),
    db.prepare(`INSERT INTO admin_records(kind,record_id,version,operation_id,body) SELECT kind,record_id,version,operation_id,body FROM admin_events WHERE operation_id=?`).bind(operationId),
    db.prepare(`INSERT INTO players(canonical_name) SELECT DISTINCT json_extract(value,'$.name') FROM json_each(?) WHERE ${present} ON CONFLICT DO NOTHING`).bind(encoded, operationId),
    db.prepare(`INSERT INTO submissions(week_id,player_id,submitted_name,week_name,best_bet_game_index,best_bet_team,tiebreaker,source,submitted_at,superseded_at)
      SELECT ?,p.id,json_extract(card.value,'$.submittedName'),json_extract(card.value,'$.weekName'),json_extract(card.value,'$.bestBetIndex'),json_extract(card.value,'$.bestBet'),
        json_extract(card.value,'$.tiebreaker'),'source-original',json_extract(card.value,'$.submittedAt'),json_extract(card.value,'$.supersededAt')
      FROM json_each(?) card JOIN players p ON p.canonical_name=json_extract(card.value,'$.name') COLLATE NOCASE WHERE ${present}`)
      .bind(week.id, encoded, operationId),
    db.prepare(`INSERT INTO submission_picks(submission_id,game_id,picked_team)
      SELECT s.id,g.id,pick.value FROM json_each(?) card JOIN players p ON p.canonical_name=json_extract(card.value,'$.name') COLLATE NOCASE
      JOIN submissions s ON s.player_id=p.id AND s.week_id=? AND s.submitted_at=json_extract(card.value,'$.submittedAt')
      JOIN json_each(card.value,'$.picks') pick JOIN games g ON g.week_id=s.week_id AND g.game_index=pick.key WHERE ${present}`)
      .bind(encoded, week.id, operationId),
    db.prepare(`INSERT INTO admin_submission_links(record_id,submission_id)
      SELECT json_extract(card.value,'$.recordId'),s.id FROM json_each(?) card JOIN players p ON p.canonical_name=json_extract(card.value,'$.name') COLLATE NOCASE
      JOIN submissions s ON s.player_id=p.id AND s.week_id=? AND s.submitted_at=json_extract(card.value,'$.submittedAt') WHERE ${present}`)
      .bind(encoded, week.id, operationId),
  ]);
  if (!await db.prepare('SELECT operation_id FROM admin_events WHERE operation_id=?').bind(operationId).first()) throw new Error('Ownership, source cards, or slate changed; import was fenced.');
  await verify();
  return { season, week: weekNumber, cards: cards.length, inserted: cards.length, verified: true, sourceWrites: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const target = args[0]?.match(/^--rehearse=(20\d{2}):([1-9]|1[0-8])$/);
  const filename = args[1]?.startsWith('--checkpoint=') ? args[1].slice(13) : '';
  if (args.length !== 2 || !target || !filename) throw new Error('Use --rehearse=2026:3 --checkpoint=PRIVATE_CHECKPOINT. This command cannot write to production.');
  const checkpoint = JSON.parse(await readFile(filename, 'utf8'));
  console.log(JSON.stringify(await rehearseOperationalCheckpoint(checkpoint, async ({ sqlite, adapter }) => {
    if (checkpoint.payload.version === 2) sqlite.exec(await readFile(new URL('../migrations/0016_independent_best_bet.sql', import.meta.url), 'utf8'));
    try {
      const mapped = await importOperationalOriginals(adapter, Number(target[1]), Number(target[2]), { apply: true });
      const replay = await importOperationalOriginals(adapter, Number(target[1]), Number(target[2]), { apply: true });
      return { originalMapping: mapped, replayInserted: replay.inserted, foreignKeyErrors: sqlite.prepare('PRAGMA foreign_key_check').all().length };
    } catch (error) {
      return { originalMapping: 'blocked', reason: error.message };
    }
  })));
}