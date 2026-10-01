import { readFile } from 'node:fs/promises';
import { adminDigest, canonicalAdminJson } from '../src/admin-store.ts';
import { memoryDatabase } from '../test/helpers/d1.mjs';

const tables = {
  admin_control: 'id',
  weeks: 'id', games: 'id', game_states: 'game_id', players: 'id',
  submissions: 'id', submission_picks: 'submission_id,game_id', submission_corrections: 'id',
  live_snapshots: 'id', race_snapshots: 'id', completed_week_archives: 'week_id',
  candidate_weeks: 'season,week,phase', candidate_race_frames: 'season,week,phase,interval_id', candidate_archives: 'season,week,phase',
  admin_events: 'kind,record_id,version', admin_records: 'kind,record_id',
  payout_journal: 'record_id,version', operational_receipts: 'operation_id',
  playoff_eligibility: 'season,player_name', admin_submission_links: 'record_id',
  submission_confirmation_outbox: 'operation_id',
};
const migrations = ['0001_initial.sql', '0009_admin_record_history.sql', '0010_candidate_lifecycle.sql', '0011_payout_journal.sql', '0012_submission_admin_projection.sql', '0013_operational_receipts.sql', '0014_playoff_eligibility.sql', '0017_submission_confirmation_outbox.sql'];

export async function createOperationalCheckpoint(db) {
  const columns = (await db.prepare('PRAGMA table_info(submissions)').all()).results;
  const available = new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map(row => String(row.name)));
  const presentTables = Object.entries(tables).filter(([table]) => available.has(table));
  const results = await db.batch(presentTables.map(([table, order]) => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`)));
  const captured = new Map(presentTables.map(([table], index) => [table, results[index].results]));
  const payload = { version: columns.some(column => column.name === 'best_bet_team') ? 3 : 2,
    tables: Object.fromEntries(Object.keys(tables).map(table => [table, captured.get(table) || []])) };
  return { sha256: await adminDigest(canonicalAdminJson(payload)), payload,
    absentTables: Object.keys(tables).filter(table => !available.has(table)) };
}

export async function rehearseOperationalCheckpoint(checkpoint, inspectRestored = null) {
  if (![2, 3].includes(checkpoint?.payload?.version) || await adminDigest(canonicalAdminJson(checkpoint.payload)) !== checkpoint.sha256
    || JSON.stringify(Object.keys(checkpoint.payload.tables).sort()) !== JSON.stringify(Object.keys(tables).sort())) throw new Error('Operational checkpoint checksum or schema mismatch.');
  const captured = checkpoint.payload.tables;
  if (captured.admin_control.length !== 1 || !Number.isSafeInteger(captured.admin_control[0].epoch)) throw new Error('Invalid checkpoint ownership.');
  const { sqlite, adapter } = memoryDatabase(checkpoint.payload.version === 3 ? [...migrations, '0016_independent_best_bet.sql'] : migrations);
  try {
    for (const table of Object.keys(tables)) {
      if (['admin_control', 'payout_journal'].includes(table)) continue;
      const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
      const insert = sqlite.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      for (const row of captured[table]) {
        if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...columns].sort())) throw new Error(`Checkpoint columns disagree for ${table}.`);
        if (table === 'operational_receipts') sqlite.prepare("UPDATE admin_control SET owner='D1',epoch=? WHERE id=1").run(row.epoch);
        insert.run(...columns.map(column => row[column]));
      }
    }
    sqlite.prepare('UPDATE admin_control SET owner=?,epoch=? WHERE id=1').run(captured.admin_control[0].owner, captured.admin_control[0].epoch);
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Recovered operational checkpoint has foreign-key violations.');
    const restored = await createOperationalCheckpoint(adapter);
    restored.payload.version = checkpoint.payload.version;
    if (await adminDigest(canonicalAdminJson(restored.payload)) !== checkpoint.sha256) throw new Error('Recovered operational state does not exactly match the checkpoint.');
    const inspection = inspectRestored ? await inspectRestored({ sqlite, adapter }) : null;
    sqlite.exec(await readFile(new URL('../migrations/0015_active_week_cutover_guard.sql', import.meta.url), 'utf8'));
    sqlite.prepare("UPDATE admin_control SET owner='SHEETS',epoch=epoch+1 WHERE id=1").run();
    return { exactStateRestored: true, epoch: captured.admin_control[0].epoch + 1,
      counts: Object.fromEntries(Object.keys(tables).map(table => [table, captured[table].length])),
      ...(inspection ? { inspection } : {}),
      productionWrites: 0, fullReplacementReady: false };
  } finally { sqlite.close(); }
}