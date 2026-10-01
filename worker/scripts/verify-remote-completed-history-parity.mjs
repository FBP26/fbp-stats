import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { buildCompletedHistory } from './publish-d1-completed-history.mjs';
import { assertCompletedHistoryParity } from './verify-completed-history-parity.mjs';

function integerOption(args, name) {
  const value = args.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`--${name}=INTEGER is required.`);
  return number;
}

async function main() {
  const args = process.argv.slice(2);
  const csvDirectory = args.find(argument => argument.startsWith('--csv-dir='))?.slice(10);
  const season = integerOption(args, 'season');
  const week = integerOption(args, 'week');
  if (!args.includes('--remote') || !csvDirectory || args.length !== 4
    || args.some(argument => argument !== '--remote' && !argument.startsWith('--csv-dir=') && !argument.startsWith('--season=') && !argument.startsWith('--week='))) {
    throw new Error('Use --remote --csv-dir=CANONICAL_CSV_DIRECTORY --season=YYYY --week=N. This verifier never writes files or D1.');
  }
  const proxy = await getPlatformProxy({ configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)), persist: false, remoteBindings: true });
  try {
    const completed = await buildCompletedHistory(proxy.env.DB);
    const archive = completed.document.weeks.find(candidate => candidate.season === season && candidate.week === week);
    if (!archive) throw new Error(`No immutable D1 completed archive exists for ${season} Week ${week}.`);
    if (archive.phase !== 'REGULAR_SEASON') throw new Error('Canonical CSV parity is currently defined only for regular-season archives.');
    const csvPath = resolve(csvDirectory, `${season}-${season + 1}_week_${String(week).padStart(2, '0')}.csv`);
    const result = assertCompletedHistoryParity({ ...archive, seasonStart: archive.season }, await readFile(csvPath, 'utf8'));
    console.log(JSON.stringify({ ...result, season, week, archiveChecksum: archive.archiveChecksum, csvPath, productionWrites: 0 }));
  } finally {
    await proxy.dispose();
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).pathname) main().catch(error => { console.error(error.message); process.exitCode = 1; });