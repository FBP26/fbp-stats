import assert from 'node:assert/strict';
import test from 'node:test';
import { synchronizeShadowCards } from '../src/shadow-sync.ts';
import { memoryDatabase } from './helpers/d1.mjs';

const fixture = () => ({
  ok: true, season: 2026, week: 3,
  games: [{ gameId: '2026092401', favorite: 'BUF', underdog: 'mia', status: 'PREGAME' }],
  players: [
    { name: 'Jim', weekName: 'None', picks: ['BUF'], bestBet: 'BUF', tiebreaker: 450, submittedAt: '2026-09-24T10:00:00Z' },
    { name: 'Mac', picks: ['mia'], bestBet: 'mia', tiebreaker: 500 },
  ],
});
const count = (sqlite, table) => sqlite.prepare(`SELECT count(*) AS total FROM ${table}`).get().total;

test('shadow cycle preserves history through replay, correction, revert, disappearance, finalization and rollover', async () => {
  const { sqlite, adapter } = memoryDatabase(['0008_shadow_card_sync.sql']);
  try {
    sqlite.exec("CREATE TABLE submissions (id INTEGER PRIMARY KEY, protected TEXT); INSERT INTO submissions VALUES (1, 'unchanged');");
    const current = fixture();
    await synchronizeShadowCards(adapter, current, 1000);
    await synchronizeShadowCards(adapter, current, 1000);
    current.games[0].status = 'IN_PROGRESS';
    current.players[0].wins = 2;
    await synchronizeShadowCards(adapter, current, 2000);
    assert.equal(count(sqlite, 'shadow_card_revisions'), 2, 'Polling and live scores do not manufacture card revisions');
    assert.equal(sqlite.prepare("SELECT submitted_at FROM shadow_card_revisions WHERE player_key='jim'").get().submitted_at, '2026-09-24T10:00:00.000Z');
    assert.equal(sqlite.prepare("SELECT submitted_at FROM shadow_card_revisions WHERE player_key='mac'").get().submitted_at, null, 'Missing source time stays unknown');
    assert.equal(JSON.parse(sqlite.prepare("SELECT card_json FROM shadow_card_revisions WHERE player_key='jim'").get().card_json).weekName, 'None');
    current.players[0].tiebreaker = 451;
    await synchronizeShadowCards(adapter, current, 3000);
    assert.equal(count(sqlite, 'shadow_card_revisions'), 3);
    const revisedHead = sqlite.prepare("SELECT revision_id FROM shadow_card_heads WHERE player_key='jim'").get().revision_id;
    await synchronizeShadowCards(adapter, fixture(), 2500);
    assert.equal(sqlite.prepare("SELECT revision_id FROM shadow_card_heads WHERE player_key='jim'").get().revision_id, revisedHead, 'Delayed observations cannot rewind state');
    current.players[0].tiebreaker = 450;
    await synchronizeShadowCards(adapter, current, 4000);
    assert.equal(count(sqlite, 'shadow_card_revisions'), 4, 'A revert remains a distinct audited transition');
    current.players.pop();
    await synchronizeShadowCards(adapter, current, 5000);
    assert.equal(count(sqlite, 'shadow_card_heads'), 2, 'Missing cards are retained, not deleted');
    assert.deepEqual(JSON.parse(sqlite.prepare('SELECT members_json FROM shadow_sync_weeks').get().members_json), ['jim']);
    current.games[0].status = 'FINAL';
    await synchronizeShadowCards(adapter, current, 6000);
    const next = fixture(); next.week = 4;
    await synchronizeShadowCards(adapter, next, 7000);
    assert.equal(count(sqlite, 'shadow_sync_weeks'), 2);
    assert.equal(count(sqlite, 'shadow_card_revisions'), 6);
    assert.equal(sqlite.prepare('SELECT protected FROM submissions').get().protected, 'unchanged');
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { sqlite.close(); }
});

test('invalid source cards reject the whole observation before writing', async () => {
  const { sqlite, adapter } = memoryDatabase(['0008_shadow_card_sync.sql']);
  try {
    for (const mutate of [
      data => data.players.push({ ...data.players[0], name: ' jim ' }),
      data => data.players[0].picks = ['KC'],
      data => data.players[0].tiebreaker = '',
      data => data.players[0].submittedAt = 'not-a-date',
      data => data.games[0].gameId = '',
    ]) {
      const current = fixture(); mutate(current);
      await assert.rejects(synchronizeShadowCards(adapter, current, 1000));
      assert.equal(count(sqlite, 'shadow_card_revisions'), 0);
      assert.equal(count(sqlite, 'shadow_sync_weeks'), 0);
    }
  } finally { sqlite.close(); }
});

test('a failed head update rolls back revisions and the observed-week watermark', async () => {
  const { sqlite, adapter } = memoryDatabase(['0008_shadow_card_sync.sql']);
  try {
    sqlite.exec("CREATE TRIGGER reject_head BEFORE INSERT ON shadow_card_heads BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");
    await assert.rejects(synchronizeShadowCards(adapter, fixture(), 1000), /forced failure/);
    assert.equal(count(sqlite, 'shadow_card_revisions'), 0);
    assert.equal(count(sqlite, 'shadow_sync_weeks'), 0);
  } finally { sqlite.close(); }
});