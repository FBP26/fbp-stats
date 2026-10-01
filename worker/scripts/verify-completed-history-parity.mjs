import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { adaptCompletedArchive } from '../src/completed-history-adapter.ts';

const expectedHeaders = [
  'Season', 'Week', 'Game Num', 'Game Date', 'Favorite', 'Spread', 'Underdog', 'Home', 'Away', 'Name', 'Pick', 'Best Bet',
  'Fav Score', 'Und Score', 'Home Score', 'Away Score', 'Result', 'BB Result', 'Result Win', 'Result Loss', 'Result Push',
  'BB Win', 'BB Loss', 'BB Push', 'Tiebreaker', 'Actual Tiebreak',
];

const normalizeText = value => String(value ?? '').trim().toUpperCase();
const normalizeNumber = value => {
  const number = Number(String(value ?? '').trim());
  if (!Number.isFinite(number)) throw new Error(`Expected a number, received ${JSON.stringify(value)}.`);
  return number;
};
const normalizeNullableNumber = value => String(value ?? '').trim() === '' ? null : normalizeNumber(value);
const normalizeResult = value => String(value ?? '').trim().toLowerCase();
const recordKey = record => `${record.gameId}\u0000${normalizeText(record.name)}`;

function seasonLabel(seasonStart) {
  const start = Number(seasonStart);
  if (!Number.isInteger(start)) throw new Error(`Archive season ${JSON.stringify(seasonStart)} is invalid.`);
  return `${start}-${start + 1}`;
}

function archiveForAdapter(archive) {
  return { ...archive, season: seasonLabel(archive.seasonStart) };
}

function csvDateToIsoDay(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) throw new Error(`Canonical CSV date ${JSON.stringify(value)} is invalid.`);
  return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

function requireHeader(row) {
  for (const header of expectedHeaders) {
    if (!(header in row)) throw new Error(`Canonical CSV is missing ${header}.`);
  }
}

export function parseCanonicalCompletedCsv(csvText) {
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  if (!rows.length) throw new Error('Canonical CSV has no completed pick rows.');
  const records = new Map();
  for (const row of rows) {
    requireHeader(row);
    const gameId = `${String(row.Season).trim()}|${normalizeNumber(row.Week)}|${normalizeNumber(row['Game Num'])}`;
    const record = {
      gameId,
      gameDate: csvDateToIsoDay(row['Game Date']),
      favorite: normalizeText(row.Favorite), underdog: normalizeText(row.Underdog), home: normalizeText(row.Home), away: normalizeText(row.Away),
      spread: normalizeNumber(row.Spread), favoriteScore: normalizeNumber(row['Fav Score']), underdogScore: normalizeNumber(row['Und Score']),
      homeScore: normalizeNumber(row['Home Score']), awayScore: normalizeNumber(row['Away Score']),
      name: normalizeText(row.Name), pick: normalizeText(row.Pick), bestBet: normalizeText(row['Best Bet']),
      result: normalizeResult(row.Result), bestBetResult: normalizeResult(row['BB Result']) || null,
      resultWin: normalizeNumber(row['Result Win']), resultLoss: normalizeNumber(row['Result Loss']), resultPush: normalizeNumber(row['Result Push']),
      bestBetWin: normalizeNumber(row['BB Win']), bestBetLoss: normalizeNumber(row['BB Loss']), bestBetPush: normalizeNumber(row['BB Push']),
      tiebreaker: normalizeNullableNumber(row.Tiebreaker), actualTiebreak: normalizeNullableNumber(row['Actual Tiebreak']),
    };
    const key = recordKey(record);
    if (records.has(key)) throw new Error(`Canonical CSV has duplicate pick record ${key}.`);
    records.set(key, record);
  }
  return records;
}

function comparableProjectedRecord(game, pick) {
  return {
    gameId: game.gameId, gameDate: game.gameDate, favorite: normalizeText(game.favorite), underdog: normalizeText(game.underdog),
    home: normalizeText(game.home), away: normalizeText(game.away), spread: Number(game.spread),
    favoriteScore: normalizeText(game.favorite) === normalizeText(game.home) ? Number(game.homeScore) : Number(game.awayScore),
    underdogScore: normalizeText(game.underdog) === normalizeText(game.home) ? Number(game.homeScore) : Number(game.awayScore),
    homeScore: Number(game.homeScore), awayScore: Number(game.awayScore), name: normalizeText(pick.name), pick: normalizeText(pick.pick), bestBet: normalizeText(pick.bestBet),
    result: normalizeResult(pick.result), bestBetResult: pick.bestBetResult, resultWin: Number(pick.resultWin), resultLoss: Number(pick.resultLoss), resultPush: Number(pick.resultPush),
    bestBetWin: Number(pick.bestBetWin), bestBetLoss: Number(pick.bestBetLoss), bestBetPush: Number(pick.bestBetPush),
    tiebreaker: pick.tiebreaker === null ? null : Number(pick.tiebreaker), actualTiebreak: pick.actualTiebreak === null ? null : Number(pick.actualTiebreak),
  };
}

export function assertCompletedHistoryParity(archive, csvText) {
  const projected = adaptCompletedArchive(archiveForAdapter(archive));
  const games = new Map(projected.games.map(game => [game.gameId, game]));
  const canonical = parseCanonicalCompletedCsv(csvText);
  if (canonical.size !== projected.picks.length) throw new Error(`Pick row count differs: D1=${projected.picks.length}, canonical=${canonical.size}.`);
  for (const pick of projected.picks) {
    const game = games.get(pick.gameId);
    const actual = canonical.get(recordKey(pick));
    if (!actual) throw new Error(`Canonical CSV is missing D1 pick record ${recordKey(pick)}.`);
    const expected = comparableProjectedRecord(game, pick);
    for (const [field, value] of Object.entries(expected)) {
      if (!Object.is(actual[field], value)) throw new Error(`Parity mismatch for ${recordKey(pick)} field ${field}: D1=${JSON.stringify(value)}, canonical=${JSON.stringify(actual[field])}.`);
    }
  }
  return { ok: true, games: projected.games.length, picks: projected.picks.length };
}

async function main() {
  const args = process.argv.slice(2);
  const archivePath = args.find(arg => arg.startsWith('--archive='))?.slice(10);
  const csvPath = args.find(arg => arg.startsWith('--csv='))?.slice(6);
  if (!archivePath || !csvPath || args.length !== 2) throw new Error('Use --archive=PATH --csv=PATH. This verifier never writes files.');
  const archive = JSON.parse(await readFile(archivePath, 'utf8'));
  const result = assertCompletedHistoryParity(archive, await readFile(csvPath, 'utf8'));
  console.log(JSON.stringify(result));
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).pathname) main().catch(error => { console.error(error.message); process.exitCode = 1; });