import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase } from './helpers/d1.mjs';
import { publicReadSnapshot, refreshPublicReadSnapshots, validatePublicReadPair, snapshotMaxAgeMs } from '../src/read-snapshots.ts';

const games = [{ gameId: '2026092401', favorite: 'BUF', underdog: 'mia', spread: 3 }];
const active = { ok: true, staged: true, season: 2026, week: 3, games };
const current = { ok: true, season: 2026, week: 3, games, favorites: ['BUF'], underdogs: ['mia'], spreads: [3], players: [{ name: 'Jim', picks: ['BUF'], bestBet: 'BUF', tiebreaker: 450 }] };
const race = { ok: true, season: 2026, week: 3, raceSnapshots: [{ players: [{ name: 'Jim', win_prob: 1 }] }] };

function database() {
  return memoryDatabase(['0007_public_read_snapshots.sql', '0008_shadow_card_sync.sql', '0010_candidate_lifecycle.sql']);
}

const source = async url => Response.json(({ 'active-week': active, 'current-week': current, 'current-week-race': race })[new URL(url).searchParams.get('action')]);
const request = (kind, query = '') => new Request(`https://example.test/?action=public-read&kind=${kind}${query}`);

test('public snapshots preserve source data and reject stale, missing, mismatched and private reads', async () => {
  const { sqlite, adapter } = database();
  try {
    assert.equal((await publicReadSnapshot(request('current-week'), adapter, '*')).status, 503);
    await refreshPublicReadSnapshots(adapter, 'https://example.test/source', source);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM shadow_card_heads').get().total, current.players.length);
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

test('transient source HTTP errors retry once with a fresh URL; permissions fail immediately', async () => {
  const { sqlite, adapter } = database();
  const urls = [];
  try {
    await refreshPublicReadSnapshots(adapter, 'https://example.test', async url => {
      if (url.searchParams.get('action') === 'current-week') {
        urls.push(String(url));
        if (urls.length === 1) return new Response('Transient redirect failure', { status: 404 });
      }
      return source(url);
    });
    assert.equal(urls.length, 2);
    assert.notEqual(urls[0], urls[1]);
    let forbiddenCalls = 0;
    await assert.rejects(refreshPublicReadSnapshots(adapter, 'https://example.test', async url => {
      if (url.searchParams.get('action') === 'active-week') {
        forbiddenCalls++;
        return new Response('Forbidden', { status: 403 });
      }
      return source(url);
    }), /403/);
    assert.equal(forbiddenCalls, 1);
  } finally { sqlite.close(); }
});

test('live public feeds can build isolated snapshots without production writes', { skip: !process.env.FBP_SNAPSHOT_SOURCE_URL }, async () => {
  const { sqlite, adapter } = database();
  try {
    await refreshPublicReadSnapshots(adapter, process.env.FBP_SNAPSHOT_SOURCE_URL, fetch, true);
    const response = await publicReadSnapshot(request('current-week'), adapter, '*');
    assert.equal(response.status, 200);
    const payload = await response.json();
    console.log(JSON.stringify({ week: payload.week, games: payload.games.length, players: payload.players.length, snapshots: sqlite.prepare('SELECT count(*) AS total FROM public_read_snapshots').get().total, productionWrites: 0 }));
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM public_read_snapshots').get().total, 3);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM shadow_card_heads').get().total, payload.players.length);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM candidate_weeks').get().total, 1);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('shadow storage failure cannot interrupt public snapshots or the race refresh', async () => {
  const { sqlite, adapter } = database();
  try {
    sqlite.exec("CREATE TRIGGER reject_shadow BEFORE INSERT ON shadow_card_heads BEGIN SELECT RAISE(ABORT, 'forced shadow failure'); END;");
    await refreshPublicReadSnapshots(adapter, 'https://example.test', source);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM public_read_snapshots').get().total, 3);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM shadow_card_revisions').get().total, 0);
  } finally { sqlite.close(); }
});

test('scheduled candidate recorder computes race frames and its failure cannot block public reads', async () => {
  const { sqlite, adapter } = database();
  const candidateCurrent = { ...current, games: games.map(game => ({ ...game, kickoff: '2026-09-27T17:00:00Z', status: 'PREGAME' })) };
  const feeds = async url => new URL(url).searchParams.get('action') === 'current-week' ? Response.json(candidateCurrent) : source(url);
  try {
    await refreshPublicReadSnapshots(adapter, 'https://example.test', feeds, true);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM candidate_race_frames').get().total, 1);
    sqlite.exec("CREATE TRIGGER reject_candidate BEFORE INSERT ON candidate_weeks BEGIN SELECT RAISE(ABORT, 'forced candidate failure'); END");
    await refreshPublicReadSnapshots(adapter, 'https://example.test', feeds, true);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM public_read_snapshots').get().total, 3);
  } finally { sqlite.close(); }
});