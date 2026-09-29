import { getPlatformProxy } from 'wrangler';
import { observeCandidatePublicWeek } from '../src/candidate-lifecycle.ts';
import { validatePublicReadPair } from '../src/read-snapshots.ts';
import { memoryDatabase } from '../test/helpers/d1.mjs';
import { fileURLToPath } from 'node:url';
import { compareCandidateArchive } from './candidate-parity.mjs';
import { createOperationalCheckpoint, rehearseOperationalCheckpoint } from './operational-checkpoint.mjs';

const argumentsList = process.argv.slice(2);
const finalMatch = argumentsList[0]?.match(/^--compare-final=(20\d{2}):([1-9]|1[0-8])$/);
const recover = argumentsList[0] === '--rehearse-operational';
if (argumentsList.length && (argumentsList.length !== 1 || (!finalMatch && !recover))) throw new Error('Usage: node scripts/check-candidate-observer.mjs [--compare-final=2026:3 | --rehearse-operational]');
const proxy = await getPlatformProxy({ configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)), experimental: { remoteBindings: true } });
const { sqlite, adapter } = memoryDatabase(['0010_candidate_lifecycle.sql']);
try {
  if (recover) {
    console.log(JSON.stringify(await rehearseOperationalCheckpoint(await createOperationalCheckpoint(proxy.env.DB))));
  } else if (finalMatch) {
    const season = Number(finalMatch[1]), week = Number(finalMatch[2]);
    const archive = await proxy.env.DB.prepare('SELECT checksum, payload_json FROM candidate_archives WHERE season = ? AND week = ? AND phase = ?').bind(season, week, 'REGULAR_SEASON').first();
    if (!archive) {
      console.log(JSON.stringify({ season, week, finalResultParity: 'pending', reason: 'No finalized candidate archive yet.', fullReplacementReady: false, productionWrites: 0 }));
    } else {
      const response = await fetch(`https://fbp26.github.io/fbp-stats/data/latest-completed-week.json?_=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(35000) });
      if (!response.ok) throw new Error(`Published archive returned HTTP ${response.status}.`);
      const canonical = await response.json();
      if (canonical.season !== season || canonical.week !== week) {
        console.log(JSON.stringify({ season, week, finalResultParity: 'pending', reason: 'Requested week is not the published latest completed week.', fullReplacementReady: false, productionWrites: 0 }));
      } else {
        console.log(JSON.stringify(compareCandidateArchive(archive, canonical)));
      }
    }
  } else {
  const snapshots = await proxy.env.DB.prepare("SELECT name, season, week, read_started_at, payload FROM public_read_snapshots WHERE name IN ('active-week', 'current-week')").all();
  const payloads = {};
  for (const row of snapshots.results) {
    const stream = new Blob([new Uint8Array(row.payload)]).stream().pipeThrough(new DecompressionStream('gzip'));
    payloads[row.name] = { row, data: await new Response(stream).json() };
  }
  const active = payloads['active-week'];
  const current = payloads['current-week'];
  if (!active || !current || active.row.read_started_at !== current.row.read_started_at) throw new Error('Missing or mismatched source snapshots.');
  validatePublicReadPair(active.data, current.data);
  const prior = await proxy.env.DB.prepare('SELECT * FROM candidate_weeks WHERE season = ? AND week = ? AND phase = ?').bind(current.row.season, current.row.week, 'REGULAR_SEASON').first();
  if (prior) sqlite.prepare('INSERT INTO candidate_weeks (season, week, phase, slate_hash, status, observed_open, observed_live, read_started_at, latest_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(prior.season, prior.week, prior.phase, prior.slate_hash, prior.status, prior.observed_open, prior.observed_live, prior.read_started_at, prior.latest_json);
  const archive = await proxy.env.DB.prepare('SELECT * FROM candidate_archives WHERE season = ? AND week = ? AND phase = ?').bind(current.row.season, current.row.week, 'REGULAR_SEASON').first();
  if (archive) sqlite.prepare('INSERT INTO candidate_archives (season, week, phase, checksum, payload_json, finalized_at) VALUES (?, ?, ?, ?, ?, ?)').run(archive.season, archive.week, archive.phase, archive.checksum, archive.payload_json, archive.finalized_at);
  console.log(JSON.stringify({ sourceAt: new Date(current.row.read_started_at).toISOString(), sourceAgeSeconds: Math.round((Date.now() - current.row.read_started_at) / 1000), candidateAt: prior ? new Date(prior.read_started_at).toISOString() : null, season: current.row.season, week: current.row.week, cards: current.data.players.length, statuses: current.data.games.map(game => game.status), productionWrites: 0 }));
  await observeCandidatePublicWeek(adapter, active.data, current.data, current.row.read_started_at);
  console.log(JSON.stringify({ replay: 'passed', candidate: sqlite.prepare('SELECT status, observed_open, observed_live FROM candidate_weeks').get(), archives: sqlite.prepare('SELECT COUNT(*) AS count FROM candidate_archives').get().count, productionWrites: 0 }));
  }
} finally {
  sqlite.close();
  await proxy.dispose();
}