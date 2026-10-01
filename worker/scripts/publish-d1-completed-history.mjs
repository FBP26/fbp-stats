import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { adaptCompletedArchive } from '../src/completed-history-adapter.ts';
import { assertCompletedHistoryParity } from './verify-completed-history-parity.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

export async function buildCompletedHistory(db) {
  const rows = (await db.prepare(`SELECT w.season,w.week,w.phase,w.finalized_at,a.payload_json,a.checksum
    FROM completed_week_archives a JOIN weeks w ON w.id=a.week_id
    WHERE w.status='finalized' ORDER BY w.season,w.phase,w.week`).all()).results;
  const weeks = rows.map(row => {
    const payload = String(row.payload_json);
    if (digest(payload) !== String(row.checksum)) throw new Error(`Archive digest mismatch for ${row.season} Week ${row.week}.`);
    const archive = JSON.parse(payload);
    if (Number(archive.seasonStart) !== Number(row.season) || Number(archive.week) !== Number(row.week)
      || String(archive.phase) !== String(row.phase) || !Array.isArray(archive.games) || !Array.isArray(archive.submissions)) {
      throw new Error(`Archive contract mismatch for ${row.season} Week ${row.week}.`);
    }
    return { season: Number(row.season), week: Number(row.week), phase: String(row.phase), finalizedAt: String(row.finalized_at),
      archiveChecksum: String(row.checksum), sourceChecksum: String(archive.sourceChecksum || ''), actualTiebreaker: archive.actualTiebreaker,
      games: archive.games, submissions: archive.submissions };
  });
  const document = { version: 1, generatedFrom: 'D1 completed_week_archives', weeks };
  return { document, sha256: digest(JSON.stringify(document)), weeks: weeks.length };
}

export async function buildCompletedHistoryRecords(db, readCanonicalCsv) {
  const completed = await buildCompletedHistory(db);
  const games = [], picks = [];
  for (const week of completed.document.weeks) {
    if (week.phase !== 'REGULAR_SEASON') continue;
    const archive = { ...week, seasonStart: week.season };
    if (readCanonicalCsv) assertCompletedHistoryParity(archive, await readCanonicalCsv(week));
    const records = adaptCompletedArchive({ ...archive, season: `${week.season}-${week.season + 1}` });
    games.push(...records.games);
    picks.push(...records.picks);
  }
  const document = { version: 1, generatedFrom: completed.document.generatedFrom, games, picks };
  return { document, sha256: digest(JSON.stringify(document)), weeks: completed.weeks, games: games.length, picks: picks.length };
}

async function main() {
  const args = process.argv.slice(2);
  const output = args.find(arg => arg.startsWith('--output='))?.slice(9);
  const recordsOutput = args.find(arg => arg.startsWith('--records-output='))?.slice(17);
  const csvDirectory = args.find(arg => arg.startsWith('--csv-dir='))?.slice(10);
  if (!args.includes('--remote') || !output || (recordsOutput && !csvDirectory)
    || args.some(arg => !['--remote', '--dry-run'].includes(arg) && !arg.startsWith('--output=') && !arg.startsWith('--records-output=') && !arg.startsWith('--csv-dir='))) {
    throw new Error('Use --remote --output=PATH [--records-output=PATH --csv-dir=PATH] [--dry-run]. The publisher never replaces public data files.');
  }
  const proxy = await getPlatformProxy({ configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)), persist: false, remoteBindings: true });
  try {
    const result = await buildCompletedHistory(proxy.env.DB);
    const target = resolve(output);
    const manifest = { version: 1, file: 'd1-completed-history.json', sha256: result.sha256, weeks: result.weeks, generatedAt: new Date().toISOString(), source: result.document.generatedFrom };
    const records = recordsOutput
      ? await buildCompletedHistoryRecords(proxy.env.DB, async week => readFile(resolve(csvDirectory, `${week.season}-${week.season + 1}_week_${String(week.week).padStart(2, '0')}.csv`), 'utf8'))
      : null;
    const recordsTarget = recordsOutput ? resolve(recordsOutput) : null;
    const recordsManifest = records ? { version: 1, file: 'd1-completed-history-records.json', sha256: records.sha256, weeks: records.weeks, games: records.games, picks: records.picks, generatedAt: new Date().toISOString(), source: records.document.generatedFrom } : null;
    if (!args.includes('--dry-run')) {
      await mkdir(target, { recursive: true });
      await writeFile(resolve(target, 'd1-completed-history.json'), `${JSON.stringify(result.document)}\n`, { flag: 'wx' });
      await writeFile(resolve(target, 'd1-completed-history.manifest.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
      if (records && recordsTarget) {
        await mkdir(recordsTarget, { recursive: true });
        await writeFile(resolve(recordsTarget, 'd1-completed-history-records.json'), `${JSON.stringify(records.document)}\n`, { flag: 'wx' });
        await writeFile(resolve(recordsTarget, 'd1-completed-history-records.manifest.json'), `${JSON.stringify(recordsManifest)}\n`, { flag: 'wx' });
      }
    }
    console.log(JSON.stringify({ ...manifest, output: target, records: recordsManifest, dryRun: args.includes('--dry-run') }));
  } finally { await proxy.dispose(); }
}

if (process.argv[1] && new URL(import.meta.url).pathname === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).pathname) main().catch(error => { console.error(error.message); process.exitCode = 1; });