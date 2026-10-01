import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { userInfo } from 'node:os';
import { saveAdminRecord, AdminConflict } from '../src/admin-store.ts';
import { importSourceRecords, prepareSourceRecords, refreshSourceSubmissions, reconcileSubmissionWeek } from './admin-import.mjs';
import { createAdminCheckpoint } from './admin-checkpoint.mjs';
import { postPayoutTransaction, planPayoutBaselineAdoptions } from './payout-transactions.mjs';
import { approveOperationalWeek, readOperationalSeasonStatus } from '../src/operational-weeks.ts';
import { SubmissionError } from '../src/operational-submissions.ts';

export function validateAdminChanges(current, changes, kind) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Changes are required.');
  const allowed = kind === 'submission' ? ['name', 'weekName', 'picks', 'bestBet', 'tiebreaker'] : kind === 'payout' ? ['weeks', 'balance', 'notes'] : [];
  if (!allowed.length || Object.keys(changes).some(key => !allowed.includes(key))) throw new Error('This field is not editable.');
  const body = { ...current, ...changes };
  if (kind === 'payout' && changes.balance !== undefined && changes.balance !== current.balance) throw new Error('Balance changes require a payout transaction.');
  if (kind === 'submission') {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || typeof body.weekName !== 'string' || body.weekName.length > 100
      || !Array.isArray(body.picks) || body.picks.length !== current.picks.length || body.picks.some(pick => typeof pick !== 'string' || !/^[A-Za-z]{2,4}$/.test(pick))
      || typeof body.bestBet !== 'string' || (!body.picks.some(pick => pick.toUpperCase() === body.bestBet.toUpperCase()) && body.bestBet !== current.bestBet)
      || typeof body.tiebreaker !== 'number' || !Number.isFinite(body.tiebreaker) || body.tiebreaker < -100 || body.tiebreaker > 1200) throw new Error('Invalid submission fields.');
  } else if (!Array.isArray(body.weeks) || body.weeks.length !== 19 || body.weeks.some(value => typeof value !== 'string' || value.length > 100)
    || typeof body.balance !== 'string' || !/^(?:even|[+-]?\d+(?:\.\d{1,2})?)?$/i.test(body.balance.trim())
    || typeof body.notes !== 'string' || body.notes.length > 2000) throw new Error('Invalid payout fields.');
  return body;
}

export function createAdminServer(db, { port, actor, demo = false }) {
  const origin = `http://127.0.0.1:${port}`;
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload)); };
    if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin)
      || request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Local same-origin access required.' });
    try {
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && ['/', '/admin.css', '/admin.js'].includes(url.pathname)) {
        const filename = url.pathname === '/' ? 'admin.html' : url.pathname.slice(1);
        response.writeHead(200, { 'Content-Type': filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript' });
        return response.end(await readFile(new URL(`../admin/${filename}`, import.meta.url)));
      }
      if (request.method === 'GET' && url.pathname === '/api/records') {
        const control = await db.prepare('SELECT owner, epoch FROM admin_control WHERE id = 1').first();
        const records = await db.prepare("SELECT kind, record_id, version, body FROM admin_records WHERE kind IN ('submission', 'payout') ORDER BY kind, record_id").all();
        return send(200, { control, demo, records: records.results.map(record => ({ ...record, body: JSON.parse(record.body) })) });
      }
      if (request.method === 'GET' && url.pathname === '/api/history') {
        if (!['submission', 'payout'].includes(url.searchParams.get('kind'))) return send(400, { error: 'Unsupported record kind.' });
        const history = await db.prepare('SELECT version, actor, reason, recorded_at, body FROM admin_events WHERE kind = ? AND record_id = ? ORDER BY version DESC')
          .bind(url.searchParams.get('kind'), url.searchParams.get('id')).all();
        return send(200, { history: history.results.map(record => ({ ...record, body: JSON.parse(record.body) })) });
      }
      if (request.method === 'GET' && url.pathname === '/api/week-approval-status') {
        try { return send(200, await readOperationalSeasonStatus(db)); }
        catch (error) {
          if (!(error instanceof SubmissionError) || error.status !== 404) throw error;
          const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first();
          if (control?.owner !== 'D1') throw new SubmissionError('Season status requires D1 ownership.');
          return send(200, { ok: true, ...control, season: new Date().getUTCFullYear(), week: 0, phase: 'REGULAR_SEASON', playedThisSeason: [], submittedCurrentWeek: [], notYetSubmittedCurrentWeek: [] });
        }
      }
      if (request.method === 'POST' && ['/api/records', '/api/payout-transactions', '/api/week-approvals'].includes(url.pathname)) {
        if (request.headers.origin !== origin || !String(request.headers['content-type']).startsWith('application/json')) return send(403, { error: 'Same-origin JSON required.' });
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 32768) return send(413, { error: 'Request too large.' });
          chunks.push(chunk);
        }
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.pathname === '/api/week-approvals') return send(200, await approveOperationalWeek(db, command, actor));
        if (url.pathname === '/api/payout-transactions') return send(200, await postPayoutTransaction(db, command, actor));
        const row = await db.prepare('SELECT version, body FROM admin_records WHERE kind = ? AND record_id = ?').bind(command.kind, command.recordId).first();
        if (!row) return send(404, { error: 'Record not found.' });
        const body = validateAdminChanges(JSON.parse(row.body), command.changes, command.kind);
        const receipt = await saveAdminRecord(db, { operationId: command.operationId, kind: command.kind, recordId: command.recordId,
          expectedVersion: command.expectedVersion, expectedEpoch: command.expectedEpoch, reason: command.reason, body }, actor);
        return send(200, receipt);
      }
      return send(404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof AdminConflict) return send(409, { error: error.message });
      if (error instanceof SubmissionError) return send(error.status, { error: error.message });
      if (/Invalid|editable|required|require|Accept the|JSON|size limit|Select distinct|Only blank|Allocation amount|Insufficient surplus/.test(error.message)) return send(400, { error: error.message });
      console.error('Administrative request failed:', error.constructor.name);
      return send(500, { error: 'Administrative request failed; no successful write is assumed.' });
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const payoutSource = args.find(arg => arg.startsWith('--reconcile-payouts='))?.slice('--reconcile-payouts='.length);
  const applyPayouts = args.includes('--apply-payout-baselines');
  const payoutBackup = args.find(arg => arg.startsWith('--payout-backup='))?.slice('--payout-backup='.length);
  if (applyPayouts && (!payoutSource || !payoutBackup)) throw new Error('Payout baseline acceptance requires a source export and a new private --payout-backup file.');
  const completedSlate = args.find(arg => arg.startsWith('--completed-slate='))?.slice('--completed-slate='.length);
  const applyCompletedSlate = args.includes('--apply-completed-slate');
  const slateBackup = args.find(arg => arg.startsWith('--slate-backup='))?.slice('--slate-backup='.length);
  if (applyCompletedSlate && (!completedSlate || !slateBackup)) throw new Error('Completed slate import requires a CSV and a new private --slate-backup file.');
  const mappingArgument = args.find(arg => arg.startsWith('--map-originals='));
  const mapping = mappingArgument?.match(/^--map-originals=(20\d{2}):([1-9]|1[0-8])$/);
  if ((mappingArgument && !mapping) || (args.includes('--apply-originals') && !mapping)) throw new Error('Original mapping requires --map-originals=2026:3; omit --apply-originals for a read-only plan.');
  const demo = args.includes('--demo');
  const port = Number(args.find(arg => arg.startsWith('--port='))?.split('=')[1] || 8810);
  let db;
  let dispose;
  if (demo) {
    const { memoryDatabase } = await import('../test/helpers/d1.mjs');
    const memory = memoryDatabase(['0009_admin_record_history.sql', '0011_payout_journal.sql']);
    db = memory.adapter;
    dispose = async () => memory.sqlite.close();
    for (const [kind, body] of [
      ['submission', { name: 'Example Player', weekName: 'Week Three', season: '2026-2027', week: 3, picks: Array(16).fill('BUF'), bestBet: 'BUF', tiebreaker: 400, submittedAt: '9/24/2026 12:00:00' }],
      ['payout', { name: 'Example Player', season: '2026', periods: [...Array.from({ length: 18 }, (_, index) => String(index + 1)), 'Playoffs'], weeks: Array(19).fill(''), balance: '20', notes: '' }],
    ]) await saveAdminRecord(db, { kind, recordId: `${kind}:demo`, body, expectedVersion: 0, expectedEpoch: 1, operationId: `demo-initial-${kind}`, reason: 'Demonstration fixture' }, 'demo');
  } else {
    if (!args.includes('--remote')) throw new Error('Choose --remote for authenticated cloud records or --demo for disposable sample data.');
    const { getPlatformProxy } = await import('wrangler');
    const proxy = await getPlatformProxy({ configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)), persist: false, remoteBindings: true });
    db = proxy.env.DB;
    dispose = proxy.dispose;
  }
  if (completedSlate) {
    try {
      const { importCompletedOperationalSlate, importOperationalOriginals } = await import('./operational-source-import.mjs');
      const csv = await readFile(completedSlate, 'utf8');
      const preview = await importCompletedOperationalSlate(db, csv);
      if (!applyCompletedSlate) { console.log(JSON.stringify(preview)); return; }
      if (!preview.replayed) {
        const { createOperationalCheckpoint, rehearseOperationalCheckpoint } = await import('./operational-checkpoint.mjs');
        const checkpoint = await createOperationalCheckpoint(db);
        await rehearseOperationalCheckpoint(checkpoint, async ({ adapter }) => {
          await importCompletedOperationalSlate(adapter, csv, { apply: true });
          await importOperationalOriginals(adapter, preview.season, preview.week, { apply: true });
          await importCompletedOperationalSlate(adapter, csv, { apply: true });
          await importOperationalOriginals(adapter, preview.season, preview.week, { apply: true });
        });
        await writeFile(slateBackup, JSON.stringify(checkpoint), { flag: 'wx' });
      }
      const slate = await importCompletedOperationalSlate(db, csv, { apply: true });
      const originals = await importOperationalOriginals(db, slate.season, slate.week, { apply: true });
      console.log(JSON.stringify({ slate, originals }));
    } finally { await dispose(); }
    return;
  }
  if (payoutSource) {
    try {
      const source = await prepareSourceRecords(JSON.parse(await readFile(payoutSource, 'utf8')));
      const control = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first();
      const stored = (await db.prepare("SELECT kind,record_id,version,body FROM admin_records WHERE kind='payout'").all()).results;
      const plan = planPayoutBaselineAdoptions(source, stored, control);
      if (applyPayouts && plan.commands.length) {
        const checkpoint = await createAdminCheckpoint(db);
        await writeFile(payoutBackup, JSON.stringify(checkpoint), { flag: 'wx' });
        await importSourceRecords(db, source.filter(record => record.kind === 'source-ledger'));
        for (const command of plan.commands) {
          const current = await db.prepare('SELECT owner,epoch FROM admin_control WHERE id=1').first();
          if (current.owner !== control.owner || current.epoch !== control.epoch) throw new Error('Ownership changed during baseline acceptance.');
          await postPayoutTransaction(db, command, userInfo().username);
        }
        const saved = (await db.prepare("SELECT kind,record_id,version,body FROM admin_records WHERE kind='payout'").all()).results;
        if (planPayoutBaselineAdoptions(source, saved, control).commands.length) throw new Error('Payout baseline verification failed.');
      }
      console.log(JSON.stringify({ season: plan.season, total: plan.total, previouslyAccepted: plan.accepted,
        pending: applyPayouts ? 0 : plan.commands.length,
        adopted: applyPayouts ? plan.commands.filter(command => command.type === 'ADOPT_PAYOUT_BASELINE').length : 0,
        sourceFeeUpdates: plan.commands.filter(command => command.type === 'SOURCE_ENTRY_FEES').length,
        sourceFeePeriods: plan.commands.reduce((total, command) => total + (command.sourceEntryPeriods?.length || 0), 0),
        carriedDebtsPreserved: plan.carriedDebts.length, carriedDebtCents: plan.carriedDebts.reduce((total, item) => total + item.carriedCents, 0),
        sourceWrites: 0, cashMovementCents: 0 }));
    } finally { await dispose(); }
    return;
  }
  if (mapping) {
    try {
      const { importOperationalOriginals } = await import('./operational-source-import.mjs');
      console.log(JSON.stringify(await importOperationalOriginals(db, Number(mapping[1]), Number(mapping[2]), { apply: args.includes('--apply-originals') })));
    } finally { await dispose(); }
    return;
  }
  const operationalBackupPath = args.find(arg => arg.startsWith('--operational-backup='))?.slice('--operational-backup='.length);
  if (operationalBackupPath) {
    try {
      const { createOperationalCheckpoint, rehearseOperationalCheckpoint } = await import('./operational-checkpoint.mjs');
      const checkpoint = await createOperationalCheckpoint(db);
      const rehearsal = await rehearseOperationalCheckpoint(checkpoint);
      await writeFile(operationalBackupPath, JSON.stringify(checkpoint), { flag: 'wx' });
      console.log(JSON.stringify({ sha256: checkpoint.sha256, ...rehearsal }));
    } finally { await dispose(); }
    return;
  }
  const backupPath = args.find(arg => arg.startsWith('--backup='))?.slice(9);
  if (backupPath) {
    try {
      const checkpoint = await createAdminCheckpoint(db);
      await writeFile(backupPath, JSON.stringify(checkpoint), { flag: 'wx' });
      console.log(JSON.stringify({ sha256: checkpoint.sha256, records: checkpoint.payload.records.length, events: checkpoint.payload.events.length }));
    } finally { await dispose(); }
    return;
  }
  const importPath = args.find(arg => arg.startsWith('--import='))?.slice(9);
  if (importPath) {
    try {
      const source = JSON.parse(await readFile(importPath, 'utf8'));
      const records = await prepareSourceRecords(source);
      if (args.includes('--refresh-submissions')) {
        const season = Number(args.find(arg => arg.startsWith('--season='))?.slice(9));
        const week = Number(args.find(arg => arg.startsWith('--week='))?.slice(7));
        if (!Number.isInteger(season) || season < 2000 || !Number.isInteger(week) || week < 1 || week > 18) throw new Error('Submission refresh requires a valid --season and --week for final reconciliation.');
        const result = await refreshSourceSubmissions(db, records);
        const stored = (await db.prepare("SELECT kind,record_id,body FROM admin_records WHERE kind='submission'").all()).results;
        const reconciliation = reconcileSubmissionWeek(records, stored, season, week);
        if (!reconciliation.complete) throw new Error('Submission reconciliation is incomplete; live source ownership must not change.');
        console.log(JSON.stringify({ ...result, reconciliation }));
        return;
      }
      const selectedRecords = args.includes('--source-ledgers-only') ? records.filter(record => record.kind === 'source-ledger') : records;
      console.log(JSON.stringify(await importSourceRecords(db, selectedRecords)));
    } finally { await dispose(); }
    return;
  }
  const server = createAdminServer(db, { port, actor: userInfo().username, demo });
  server.listen(port, '127.0.0.1', () => console.log(`FBP private admin: http://127.0.0.1:${port} (${demo ? 'sample data' : 'cloud rehearsal records'})`));
  const shutdown = () => server.close(async () => { await dispose(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });