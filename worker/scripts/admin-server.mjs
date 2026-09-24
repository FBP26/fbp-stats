import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { userInfo } from 'node:os';
import { saveAdminRecord, AdminConflict } from '../src/admin-store.ts';
import { importSourceRecords, prepareSourceRecords } from './admin-import.mjs';
import { createAdminCheckpoint } from './admin-checkpoint.mjs';

export function validateAdminChanges(current, changes, kind) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Changes are required.');
  const allowed = kind === 'submission' ? ['name', 'weekName', 'picks', 'bestBet', 'tiebreaker'] : kind === 'payout' ? ['weeks', 'balance', 'notes'] : [];
  if (!allowed.length || Object.keys(changes).some(key => !allowed.includes(key))) throw new Error('This field is not editable.');
  const body = { ...current, ...changes };
  if (kind === 'submission') {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || typeof body.weekName !== 'string' || body.weekName.length > 100
      || !Array.isArray(body.picks) || body.picks.length !== current.picks.length || body.picks.some(pick => typeof pick !== 'string' || !/^[A-Za-z]{2,4}$/.test(pick))
      || typeof body.bestBet !== 'string' || !body.picks.some(pick => pick.toUpperCase() === body.bestBet.toUpperCase())
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
      if (request.method === 'POST' && url.pathname === '/api/records') {
        if (request.headers.origin !== origin || !String(request.headers['content-type']).startsWith('application/json')) return send(403, { error: 'Same-origin JSON required.' });
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 32768) return send(413, { error: 'Request too large.' });
          chunks.push(chunk);
        }
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
      if (/Invalid|editable|required|JSON|size limit/.test(error.message)) return send(400, { error: error.message });
      console.error('Administrative request failed:', error.constructor.name);
      return send(500, { error: 'Administrative request failed; no successful write is assumed.' });
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const port = Number(args.find(arg => arg.startsWith('--port='))?.split('=')[1] || 8810);
  let db;
  let dispose;
  if (demo) {
    const { memoryDatabase } = await import('../test/helpers/d1.mjs');
    const memory = memoryDatabase(['0009_admin_record_history.sql']);
    db = memory.adapter;
    dispose = async () => memory.sqlite.close();
    for (const [kind, body] of [
      ['submission', { name: 'Example Player', weekName: 'Week Three', season: '2026-2027', week: 3, picks: Array(16).fill('BUF'), bestBet: 'BUF', tiebreaker: 400, submittedAt: '9/24/2026 12:00:00' }],
      ['payout', { name: 'Example Player', season: '2026', periods: Array.from({ length: 19 }, (_, index) => `Week ${index + 1}`), weeks: Array(19).fill(''), balance: '20', notes: '' }],
    ]) await saveAdminRecord(db, { kind, recordId: `${kind}:demo`, body, expectedVersion: 0, expectedEpoch: 1, operationId: `demo-initial-${kind}`, reason: 'Demonstration fixture' }, 'demo');
  } else {
    if (!args.includes('--remote')) throw new Error('Choose --remote for authenticated cloud records or --demo for disposable sample data.');
    const { getPlatformProxy } = await import('wrangler');
    const proxy = await getPlatformProxy({ configPath: fileURLToPath(new URL('../wrangler.admin.toml', import.meta.url)), persist: false, remoteBindings: true });
    db = proxy.env.DB;
    dispose = proxy.dispose;
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
      console.log(JSON.stringify(await importSourceRecords(db, records)));
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