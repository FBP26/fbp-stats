import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SUBMISSION_HEADERS = ['submittedAt', 'season', 'week', 'name', 'weekName']
  .concat(Array.from({ length: 16 }, (_, index) => `Game ${index + 1}`), ['Best Bet', 'Tiebreaker', 'source', 'browserId']);

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nameKey = value => String(value || '').trim().toLowerCase();

function localWallMillisecondsFromIso(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('D1 submission timestamp is invalid.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second), date.getUTCMilliseconds());
}

function submissionTimestampKey(value, timeZone) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 86400000);
  return localWallMillisecondsFromIso(String(value), timeZone);
}

function submissionIdentity(season, week, name, timestamp, timeZone) {
  return `${season}|${week}|${nameKey(name)}|${submissionTimestampKey(timestamp, timeZone)}`;
}

function websiteSubmissionDocument(source) {
  if (source?.version !== 1 || typeof source.timeZone !== 'string' || !Array.isArray(source.documents)) throw new Error('Invalid source snapshot.');
  const document = source.documents.find(candidate => candidate.title === 'website submissions');
  if (!document || !Array.isArray(document.values) || !Array.isArray(document.values[0])) throw new Error('Source snapshot is missing website submissions.');
  if (JSON.stringify(document.values[0]) !== JSON.stringify(SUBMISSION_HEADERS)) throw new Error('Website submissions header does not match the rollback contract.');
  if (!Array.isArray(document.formulas) || !Array.isArray(document.display) || document.values.length !== document.formulas.length || document.values.length !== document.display.length) {
    throw new Error('Source snapshot does not preserve complete website-submission evidence.');
  }
  return document;
}

function checkpointCards(checkpoint, timeZone) {
  const tables = checkpoint?.payload?.tables;
  if (!tables || !Array.isArray(tables.weeks) || !Array.isArray(tables.games) || !Array.isArray(tables.players) || !Array.isArray(tables.submissions) || !Array.isArray(tables.submission_picks)) {
    throw new Error('Operational checkpoint does not contain submission tables.');
  }
  const weeks = new Map(tables.weeks.map(week => [Number(week.id), week]));
  const players = new Map(tables.players.map(player => [Number(player.id), player]));
  const gamesByWeek = new Map();
  for (const game of tables.games) {
    const games = gamesByWeek.get(Number(game.week_id)) || [];
    games.push(game);
    gamesByWeek.set(Number(game.week_id), games);
  }
  const picksBySubmission = new Map();
  for (const pick of tables.submission_picks) {
    const picks = picksBySubmission.get(Number(pick.submission_id)) || [];
    picks.push(pick);
    picksBySubmission.set(Number(pick.submission_id), picks);
  }
  const correctedSubmissionIds = new Set((tables.submission_corrections || []).map(correction => Number(correction.submission_id)));
  let skippedSourceOriginals = 0;
  const regularSubmissions = tables.submissions.filter(submission => {
    const week = weeks.get(Number(submission.week_id));
    if (!week) throw new Error('Rollback submission is missing its staged week.');
    if (week.phase !== 'REGULAR_SEASON') return false;
    if (submission.source === 'source-original') {
      if (correctedSubmissionIds.has(Number(submission.id))) throw new Error('A preserved source-original card has D1 corrections and requires explicit reconciliation.');
      skippedSourceOriginals += 1;
      return false;
    }
    return true;
  });
  const cards = regularSubmissions.map(submission => {
    const week = weeks.get(Number(submission.week_id));
    const player = players.get(Number(submission.player_id));
    if (!player) throw new Error('Rollback submission is missing its player identity.');
    const games = (gamesByWeek.get(Number(week.id)) || []).slice().sort((left, right) => Number(left.game_index) - Number(right.game_index));
    const picks = (picksBySubmission.get(Number(submission.id)) || []).slice().sort((left, right) => Number(left.game_id) - Number(right.game_id));
    if (games.length !== 16 || games.some((game, index) => Number(game.game_index) !== index) || picks.length !== games.length) throw new Error('Rollback requires a complete 16-game regular-season card.');
    const gameIds = new Map(games.map(game => [Number(game.id), Number(game.game_index)]));
    const orderedPicks = Array(16).fill('');
    for (const pick of picks) {
      const index = gameIds.get(Number(pick.game_id));
      if (index == null || orderedPicks[index]) throw new Error('Rollback card picks are incomplete or ambiguous.');
      orderedPicks[index] = String(pick.picked_team);
    }
    const bestBet = String(submission.best_bet_team || orderedPicks[Number(submission.best_bet_game_index)] || '');
    if (!orderedPicks.every(Boolean) || !orderedPicks.some(pick => pick.toUpperCase() === bestBet.toUpperCase())) throw new Error('Rollback Best Bet is not one of the saved picks.');
    const name = String(submission.submitted_name || player.canonical_name).trim();
    return {
      identity: submissionIdentity(`${week.season}-${Number(week.season) + 1}`, week.week, name, submission.submitted_at, timeZone),
      row: [String(submission.submitted_at), `${week.season}-${Number(week.season) + 1}`, String(week.week), name, String(submission.week_name), ...orderedPicks,
        bestBet, Number(submission.tiebreaker), String(submission.source || 'd1-rollback'), ''],
    };
  }).sort((left, right) => String(left.row[0]).localeCompare(String(right.row[0])) || String(left.row[3]).localeCompare(String(right.row[3])));
  return { cards, skippedNonRegular: tables.submissions.length - regularSubmissions.length - skippedSourceOriginals, skippedSourceOriginals };
}

export function buildSheetsRollbackPlan(checkpoint, sourceSnapshot) {
  const document = websiteSubmissionDocument(sourceSnapshot);
  const existing = new Map();
  document.values.slice(1).forEach((row, index) => {
    if (!Array.isArray(row) || row.length !== SUBMISSION_HEADERS.length) throw new Error(`Invalid website-submission row ${index + 2}.`);
    existing.set(submissionIdentity(row[1], row[2], row[3], row[0], sourceSnapshot.timeZone), row);
  });
  const { cards, skippedNonRegular, skippedSourceOriginals } = checkpointCards(checkpoint, sourceSnapshot.timeZone);
  const appendRows = [];
  for (const card of cards) {
    const prior = existing.get(card.identity);
    if (!prior) {
      appendRows.push(card.row);
      continue;
    }
    const normalizedPrior = [...prior];
    normalizedPrior[0] = submissionTimestampKey(normalizedPrior[0], sourceSnapshot.timeZone);
    const normalizedCard = [...card.row];
    normalizedCard[0] = submissionTimestampKey(normalizedCard[0], sourceSnapshot.timeZone);
    if (JSON.stringify(normalizedPrior.slice(0, 23)) !== JSON.stringify(normalizedCard.slice(0, 23))) {
      throw new Error(`Sheets rollback conflict for ${card.row[3]} in ${card.row[1]} Week ${card.row[2]}.`);
    }
  }
  return {
    version: 1,
    workbookId: sourceSnapshot.workbookId,
    sourceSnapshotSha256: digest(sourceSnapshot),
    sheet: 'website submissions',
    actions: appendRows.length ? [{ type: 'appendRows', rows: appendRows }] : [],
    appendedRows: appendRows.length,
    skippedNonRegular,
    skippedSourceOriginals,
    sourceWrites: 0,
  };
}

export function rehearseSheetsRollback(checkpoint, sourceSnapshot) {
  const plan = buildSheetsRollbackPlan(checkpoint, sourceSnapshot);
  const restored = structuredClone(sourceSnapshot);
  const document = websiteSubmissionDocument(restored);
  for (const action of plan.actions) {
    if (action.type !== 'appendRows') throw new Error('Unsupported rollback action.');
    document.values.push(...action.rows.map(row => [...row]));
    document.formulas.push(...action.rows.map(row => row.map(value => String(value))));
    document.display.push(...action.rows.map(row => row.map(value => String(value))));
  }
  const replay = buildSheetsRollbackPlan(checkpoint, restored);
  if (replay.appendedRows !== 0) throw new Error('Sheets rollback rehearsal is not replay-safe.');
  return { plan, replaySafe: true, restoredSnapshot: restored, productionWrites: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checkpointPath = process.argv.find(argument => argument.startsWith('--checkpoint='))?.slice(13);
  const sourcePath = process.argv.find(argument => argument.startsWith('--source='))?.slice(9);
  const planOutputPath = process.argv.find(argument => argument.startsWith('--plan-output='))?.slice(14);
  const validArguments = process.argv.slice(2).every(argument => argument.startsWith('--checkpoint=') || argument.startsWith('--source=') || argument.startsWith('--plan-output='));
  if (!validArguments || !checkpointPath || !sourcePath) {
    throw new Error('Use --checkpoint=PRIVATE_CHECKPOINT --source=PRIVATE_SOURCE_SNAPSHOT [--plan-output=NEW_PRIVATE_PLAN]. This command never writes Sheets.');
  }
  const [checkpoint, sourceSnapshot] = await Promise.all([readFile(checkpointPath, 'utf8'), readFile(sourcePath, 'utf8')]);
  const result = rehearseSheetsRollback(JSON.parse(checkpoint), JSON.parse(sourceSnapshot));
  if (planOutputPath) await writeFile(planOutputPath, `${JSON.stringify(result.plan)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ ...result.plan, replaySafe: result.replaySafe, productionWrites: result.productionWrites }));
}