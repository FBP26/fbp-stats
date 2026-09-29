import { adminDigest, canonicalAdminJson } from '../src/admin-store.ts';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { rehearseOperationalCheckpoint } from './operational-checkpoint.mjs';

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