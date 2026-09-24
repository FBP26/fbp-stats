import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { publicReadSnapshot, refreshPublicReadSnapshots, validatePublicReadPair, snapshotMaxAgeMs } from '../src/read-snapshots.ts';

const games = [{ gameId: '2026092401', favorite: 'BUF', underdog: 'mia', spread: 3 }];
const active = { ok: true, staged: true, season: 2026, week: 3, games };
const current = { ok: true, season: 2026, week: 3, games, favorites: ['BUF'], underdogs: ['mia'], spreads: [3], players: [{ name: 'Jim', picks: ['BUF'] }] };
const race = { ok: true, season: 2026, week: 3, raceSnapshots: [{ players: [{ name: 'Jim', win_prob: 1 }] }] };

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0007_public_read_snapshots.sql', import.meta.url), 'utf8'));
  const adapter = {
    prepare(sql) {
      let values = [];
      return {
        bind(...parameters) { values = parameters.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value); return this; },
        async first() { return sqlite.prepare(sql).get(...values) || null; },
        async run() { return sqlite.prepare(sql).run(...values); },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = await Promise.all(statements.map(statement => statement.run())); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, adapter };
}

const source = async url => Response.json(({ 'active-week': active, 'current-week': current, 'current-week-race': race })[new URL(url).searchParams.get('action')]);
const request = (kind, query = '') => new Request(`https://example.test/?action=public-read&kind=${kind}${query}`);

test('public snapshots preserve source data and reject stale, missing, mismatched and private reads', async () => {
  const { sqlite, adapter } = database();
  try {
    assert.equal((await publicReadSnapshot(request('current-week'), adapter, '*')).status, 503);
    await refreshPublicReadSnapshots(adapter, 'https://example.test/source', source);
    for (const [name, expected] of [['active-week', active], ['current-week', current], ['current-week-race', race]]) {
      const response = await publicReadSnapshot(request(name, '&season=2026&week=3'), adapter, 'https://fbp26.github.io');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await response.json(), expected);
    }
    assert.equal((await publicReadSnapshot(request('current-week', '&week=2'), adapter, '*')).status, 503);
    assert.equal((await publicReadSnapshot(request('current-week-race'), adapter, '*')).status, 503);
    assert.equal((await publicReadSnapshot(request('notification-preferences'), adapter, '*')).status, 400);
    const saved = sqlite.prepare('SELECT read_started_at FROM public_read_snapshots WHERE name = ?').get('current-week');
    assert.equal((await publicReadSnapshot(request('current-week'), adapter, '*', saved.read_started_at + snapshotMaxAgeMs + 1)).status, 503);
    assert.equal((await publicReadSnapshot(request('current-week'), adapter, '*', saved.read_started_at - 1)).status, 503);
  } finally { sqlite.close(); }
});

test('mixed weeks, changed ordering and incomplete cards cannot replace good snapshots', async () => {
  assert.throws(() => validatePublicReadPair(active, { ...current, week: 4 }));
  assert.throws(() => validatePublicReadPair(active, { ...current, games: [{ ...games[0], spread: 4 }] }));
  assert.throws(() => validatePublicReadPair(active, { ...current, players: [{ name: 'Jim', picks: [] }] }));
  const { sqlite, adapter } = database();
  try {
    await refreshPublicReadSnapshots(adapter, 'https://example.test', source);
    await assert.rejects(refreshPublicReadSnapshots(adapter, 'https://example.test', async () => Response.json({ ok: false })));
    assert.deepEqual(await (await publicReadSnapshot(request('current-week'), adapter, '*')).json(), current);
    const newerTime = Date.now() + 10000;
    sqlite.prepare('UPDATE public_read_snapshots SET read_started_at = ?').run(newerTime);
    await refreshPublicReadSnapshots(adapter, 'https://example.test', source);
    assert.equal(sqlite.prepare('SELECT min(read_started_at) AS oldest FROM public_read_snapshots').get().oldest, newerTime);
  } finally { sqlite.close(); }
});

test('race failure leaves independently usable fresh slate and standings snapshots', async () => {
  const { sqlite, adapter } = database();
  try {
    await assert.rejects(refreshPublicReadSnapshots(adapter, 'https://example.test', async url => {
      if (new URL(url).searchParams.get('action') === 'current-week-race') throw new Error('race timeout');
      return source(url);
    }), /race timeout/);
    assert.equal((await publicReadSnapshot(request('active-week'), adapter, '*')).status, 200);
    assert.equal((await publicReadSnapshot(request('current-week'), adapter, '*')).status, 200);
    assert.equal((await publicReadSnapshot(request('current-week-race', '&season=2026&week=3'), adapter, '*')).status, 503);
  } finally { sqlite.close(); }
});

test('live public feeds can build isolated snapshots without production writes', { skip: !process.env.FBP_SNAPSHOT_SOURCE_URL }, async () => {
  const { sqlite, adapter } = database();
  try {
    await refreshPublicReadSnapshots(adapter, process.env.FBP_SNAPSHOT_SOURCE_URL);
    const response = await publicReadSnapshot(request('current-week'), adapter, '*');
    assert.equal(response.status, 200);
    const payload = await response.json();
    console.log(JSON.stringify({ week: payload.week, games: payload.games.length, players: payload.players.length, snapshots: sqlite.prepare('SELECT count(*) AS total FROM public_read_snapshots').get().total, productionWrites: 0 }));
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM public_read_snapshots').get().total, 3);
  } finally { sqlite.close(); }
});