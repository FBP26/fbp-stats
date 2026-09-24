import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { adminDigest, canonicalAdminJson } from '../src/admin-store.ts';

const submissionHeaders = ['submittedAt', 'season', 'week', 'name', 'weekName', ...Array.from({ length: 16 }, (_, index) => `Game ${index + 1}`), 'Best Bet', 'Tiebreaker', 'source', 'browserId'];

export function reconcilePayoutRecords(records, source) {
  const ledger = source.documents.find(document => document.title === 'payout ledger');
  const latest = new Map();
  if (ledger) for (const row of ledger.values.slice(1)) {
    if (row[2] && row.length >= 12) latest.set(String(row[2]).trim().toLowerCase(), Number(row[11]));
  }
  const currentSeason = records.filter(record => record.kind === 'payout').map(record => record.body.season).sort().at(-1);
  for (const record of records.filter(record => record.kind === 'payout' && record.body.season === currentSeason)) {
    const text = record.body.balance.trim();
    const amount = !text || /^even$/i.test(text) ? 0 : Number(text.replace(/[^0-9.-]/g, '')) * (text.startsWith('+') ? -1 : 1);
    const ledgerBalance = latest.get(record.body.name.trim().toLowerCase());
    const status = !ledger ? 'unavailable' : !Number.isFinite(amount) || (ledgerBalance !== undefined && !Number.isFinite(ledgerBalance)) ? 'invalid'
      : ledgerBalance === undefined ? amount === 0 ? 'match' : 'missing-ledger'
        : Math.abs(ledgerBalance - amount) > 0.005 ? 'mismatch' : 'match';
    record.body.reconciliation = { status, payoutBalance: Number.isFinite(amount) ? amount : null, ledgerBalance: ledgerBalance ?? null };
  }
}

export async function prepareSourceRecords(source) {
  if (source.version !== 1 || source.timeZone !== 'America/New_York' || !source.workbookId || !Array.isArray(source.documents)) throw new Error('Unsupported source export.');
  const records = [];
  for (const document of source.documents) {
    const raw = canonicalAdminJson(document);
    const checksum = await adminDigest(raw);
    records.push({ kind: 'source-ledger', recordId: `sheet:${document.sheetId}:${checksum}`, body: {
      workbookId: source.workbookId, sheetId: document.sheetId, title: document.title, timeZone: source.timeZone,
      encoding: 'gzip-base64', sha256: checksum, decodedBytes: Buffer.byteLength(raw), data: gzipSync(raw).toString('base64'),
    } });
    if (document.title === 'website submissions') {
      if (canonicalAdminJson(document.display[0]) !== canonicalAdminJson(submissionHeaders)) throw new Error('Submission headers changed.');
      for (let index = 1; index < document.values.length; index++) {
        const row = document.values[index];
        if (!row.some(value => value !== '')) continue;
        if (!row[0] || !row[1] || !row[2] || !row[3]) throw new Error('Submission source identity is incomplete.');
        const identity = await adminDigest(canonicalAdminJson([source.workbookId, document.sheetId, row[0], row[1], row[2], row[24] || '']));
        records.push({ kind: 'submission', recordId: `submission:${identity}`, body: {
          name: String(row[3]), weekName: String(row[4] ?? ''), season: String(row[1]), week: Number(row[2]),
          picks: Array.from({ length: 16 }, (_, game) => String(row[game + 5] ?? '')), bestBet: String(row[21] ?? ''), tiebreaker: Number(row[22]),
          submittedAt: document.display[index][0], submittedAtRaw: row[0], timeZone: source.timeZone,
          provenance: { workbookId: source.workbookId, sheetId: document.sheetId, sourceRow: index + 1, ledgerChecksum: checksum },
        } });
      }
    }
    if (document.title === 'payout') {
      let season = null;
      let periods = [];
      let start = -1;
      for (let index = 0; index < document.display.length; index++) {
        const row = document.display[index];
        if (/^20\d{2}$/.test(String(row[0]).trim()) && /^week$/i.test(String(document.display[index + 1]?.[0]).trim())) {
          season = String(row[0]).trim();
          periods = document.display[index + 1].slice(1, 20);
          start = index + 3;
          continue;
        }
        if (!season || index < start || !String(row[0] || '').trim()) continue;
        if (/champion|^total$/i.test(String(row[0]))) { season = null; continue; }
        const name = String(row[0]).trim();
        const identity = await adminDigest(canonicalAdminJson([season, name.toLowerCase()]));
        records.push({ kind: 'payout', recordId: `payout:${season}:${identity}`, body: {
          name, season, periods, weeks: Array.from({ length: 19 }, (_, period) => String(row[period + 1] ?? '')),
          balance: String(row[20] ?? ''), notes: '',
          provenance: { workbookId: source.workbookId, sheetId: document.sheetId, sourceRow: index + 1, ledgerChecksum: checksum },
        } });
      }
    }
  }
  reconcilePayoutRecords(records, source);
  if (new Set(records.map(record => `${record.kind}:${record.recordId}`)).size !== records.length) throw new Error('Ambiguous duplicate source identity; import refused.');
  if (!records.some(record => record.kind === 'submission') || !records.some(record => record.kind === 'payout')) throw new Error('Required source records are absent.');
  return records;
}

export async function importSourceRecords(db, records) {
  const control = await db.prepare('SELECT owner, epoch FROM admin_control WHERE id = 1').first();
  if (control.owner !== 'SHEETS') throw new Error('Source imports are fenced after D1 takes ownership.');
  const existing = await db.prepare('SELECT kind, record_id, body FROM admin_records').all();
  const prior = new Map(existing.results.map(record => [`${record.kind}:${record.record_id}`, record.body]));
  for (const record of records) {
    const previous = prior.get(`${record.kind}:${record.recordId}`);
    if (previous && previous !== canonicalAdminJson(record.body)) throw new Error('An existing record differs; automatic overwrite refused.');
  }
  let inserted = 0;
  for (let offset = 0; offset < records.length; offset += 30) {
    const statements = [];
    for (const record of records.slice(offset, offset + 30)) {
      const body = canonicalAdminJson(record.body);
      const hash = await adminDigest(body);
      const operationId = `import:${await adminDigest(`${record.kind}:${record.recordId}:${hash}`)}`;
      statements.push(db.prepare(`INSERT INTO admin_events
        (operation_id, request_hash, kind, record_id, version, epoch, actor, reason, recorded_at, body)
        SELECT ?, ?, ?, ?, 1, ?, 'source-import', 'Original private source import', ?, ?
        WHERE EXISTS (SELECT 1 FROM admin_control WHERE owner = 'SHEETS' AND epoch = ?)
          AND NOT EXISTS (SELECT 1 FROM admin_records WHERE kind = ? AND record_id = ?)
        ON CONFLICT DO NOTHING`).bind(operationId, hash, record.kind, record.recordId, control.epoch, new Date().toISOString(), body, control.epoch, record.kind, record.recordId));
      statements.push(db.prepare(`INSERT INTO admin_records(kind, record_id, version, operation_id, body)
        SELECT kind, record_id, version, operation_id, body FROM admin_events WHERE operation_id = ?
        ON CONFLICT DO NOTHING`).bind(operationId));
      if (!prior.has(`${record.kind}:${record.recordId}`)) inserted++;
    }
    await db.batch(statements);
  }
  const saved = await db.prepare('SELECT kind, record_id, body FROM admin_records').all();
  const savedMap = new Map(saved.results.map(record => [`${record.kind}:${record.record_id}`, record.body]));
  if (records.some(record => savedMap.get(`${record.kind}:${record.recordId}`) !== canonicalAdminJson(record.body))) throw new Error('Import verification failed; source data was not modified.');
  return { total: records.length, inserted, verified: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const filename = process.argv.find(argument => argument.startsWith('--check='))?.slice(8);
  if (!filename) throw new Error('Use --check=PRIVATE_SOURCE_FILE for a read-only import validation.');
  const encoded = await readFile(filename, 'utf8');
  const records = await prepareSourceRecords(JSON.parse(encoded));
  const counts = {};
  for (const record of records) counts[record.kind] = (counts[record.kind] || 0) + 1;
  const reconciliation = {};
  for (const record of records) if (record.body.reconciliation) {
    const status = record.body.reconciliation.status;
    reconciliation[status] = (reconciliation[status] || 0) + 1;
  }
  console.log(JSON.stringify({ sha256: await adminDigest(encoded), records: counts, reconciliation, databaseWrites: 0 }));
}