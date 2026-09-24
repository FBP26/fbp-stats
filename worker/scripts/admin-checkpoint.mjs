import { adminDigest, canonicalAdminJson } from '../src/admin-store.ts';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function validateHistory(payload) {
  const heads = new Map();
  const operations = new Set();
  for (const event of payload.events) {
    const key = `${event.kind}:${event.record_id}`;
    if (operations.has(event.operation_id) || event.version !== (heads.get(key)?.version || 0) + 1) throw new Error('Checkpoint history is incomplete or duplicated.');
    operations.add(event.operation_id);
    heads.set(key, event);
  }
  if (heads.size !== payload.records.length) throw new Error('Checkpoint records and history disagree.');
  for (const record of payload.records) {
    const event = heads.get(`${record.kind}:${record.record_id}`);
    if (!event || event.version !== record.version || event.operation_id !== record.operation_id || event.body !== record.body) throw new Error('Checkpoint head does not match its audit history.');
  }
}

export async function createAdminCheckpoint(db) {
  const control = await db.prepare('SELECT owner, epoch FROM admin_control WHERE id = 1').first();
  const events = await db.prepare('SELECT * FROM admin_events ORDER BY kind, record_id, version').all();
  const records = await db.prepare('SELECT * FROM admin_records ORDER BY kind, record_id').all();
  const finalControl = await db.prepare('SELECT owner, epoch FROM admin_control WHERE id = 1').first();
  if (canonicalAdminJson(control) !== canonicalAdminJson(finalControl)) throw new Error('Ownership changed during checkpoint creation.');
  const payload = { version: 1, control, events: events.results, records: records.results };
  validateHistory(payload);
  return { sha256: await adminDigest(canonicalAdminJson(payload)), payload };
}

export async function restoreAdminCheckpoint(db, checkpoint) {
  if (checkpoint?.payload?.version !== 1 || await adminDigest(canonicalAdminJson(checkpoint.payload)) !== checkpoint.sha256) throw new Error('Checkpoint checksum mismatch.');
  validateHistory(checkpoint.payload);
  const counts = await db.prepare('SELECT (SELECT count(*) FROM admin_records) + (SELECT count(*) FROM admin_events) AS total').first();
  if (counts.total) throw new Error('Recovery requires an empty administrative database; existing edits will not be overwritten.');
  const statements = [
    db.prepare(`INSERT INTO admin_events(operation_id, request_hash, kind, record_id, version, epoch, actor, reason, recorded_at, body)
      SELECT json_extract(value, '$.operation_id'), json_extract(value, '$.request_hash'), json_extract(value, '$.kind'),
        json_extract(value, '$.record_id'), json_extract(value, '$.version'), json_extract(value, '$.epoch'),
        json_extract(value, '$.actor'), json_extract(value, '$.reason'), json_extract(value, '$.recorded_at'), json_extract(value, '$.body')
      FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM admin_records)`).bind(JSON.stringify(checkpoint.payload.events)),
    db.prepare(`INSERT INTO admin_records(kind, record_id, version, operation_id, body)
      SELECT json_extract(value, '$.kind'), json_extract(value, '$.record_id'), json_extract(value, '$.version'),
        json_extract(value, '$.operation_id'), json_extract(value, '$.body') FROM json_each(?)
      WHERE NOT EXISTS (SELECT 1 FROM admin_records)`).bind(JSON.stringify(checkpoint.payload.records)),
    db.prepare("UPDATE admin_control SET owner = 'SHEETS', epoch = MAX(epoch, ?) + 1 WHERE id = 1").bind(checkpoint.payload.control.epoch),
  ];
  await db.batch(statements);
  const restored = await createAdminCheckpoint(db);
  if (canonicalAdminJson(restored.payload.records) !== canonicalAdminJson(checkpoint.payload.records)
    || canonicalAdminJson(restored.payload.events) !== canonicalAdminJson(checkpoint.payload.events)) throw new Error('Restored checkpoint verification failed.');
  return { records: restored.payload.records.length, events: restored.payload.events.length, epoch: restored.payload.control.epoch };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const filename = process.argv.find(argument => argument.startsWith('--rehearse='))?.slice(11);
  if (!filename) throw new Error('Use --rehearse=PRIVATE_CHECKPOINT_FILE for an isolated recovery rehearsal.');
  const { memoryDatabase } = await import('../test/helpers/d1.mjs');
  const { sqlite, adapter } = memoryDatabase(['0009_admin_record_history.sql']);
  try {
    const checkpoint = JSON.parse(await readFile(filename, 'utf8'));
    console.log(JSON.stringify({ ...await restoreAdminCheckpoint(adapter, checkpoint), productionWrites: 0 }));
  } finally { sqlite.close(); }
}