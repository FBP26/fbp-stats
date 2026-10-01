import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { memoryDatabase } from './helpers/d1.mjs';
import { buildCompletedHistory, buildCompletedHistoryRecords } from '../scripts/publish-d1-completed-history.mjs';
import worker, { readCompletedHistory, readCompletedHistoryRecords } from '../src/index.ts';

const checksum = value => createHash('sha256').update(value).digest('hex');

function archive(season, week, phase = 'REGULAR_SEASON') {
  return JSON.stringify({
    seasonStart: season,
    week,
    phase,
    sourceChecksum: `source-${season}-${week}`,
    actualTiebreaker: 388,
    games: [{ gameIndex: 0, gameId: `game-${week}`, kickoff: '2026-09-29T00:00:00Z', favorite: 'BUF', underdog: 'mia', spread: 3, homeTeam: 'BUF', awayTeam: 'mia', state: 'FINAL', favoriteScore: 24, underdogScore: 16 }],
    submissions: [{ name: 'Example', picks: ['BUF'], bestBet: 'BUF', tiebreaker: 400 }],
  });
}

test('completed-history export includes only finalized immutable archives', async () => {
  const { sqlite, adapter } = memoryDatabase(['0001_initial.sql']);
  try {
    const finalized = archive(2026, 3);
    sqlite.prepare("INSERT INTO weeks(id,season,week,phase,status,finalized_at) VALUES(1,2026,3,'REGULAR_SEASON','finalized','2026-09-29T00:00:00Z')").run();
    sqlite.prepare('INSERT INTO completed_week_archives(week_id,payload_json,checksum,finalized_at) VALUES(?,?,?,?)').run(1, finalized, checksum(finalized), '2026-09-29T00:00:00Z');
    sqlite.prepare("INSERT INTO weeks(id,season,week,phase,status) VALUES(2,2026,4,'REGULAR_SEASON','open')").run();

    const result = await buildCompletedHistory(adapter);
    assert.equal(result.weeks, 1);
    assert.equal(result.document.weeks[0].week, 3);
    assert.equal(result.document.weeks[0].submissions[0].name, 'Example');
    assert.equal(result.sha256, checksum(JSON.stringify(result.document)));
  } finally {
    sqlite.close();
  }
});

test('completed-history export fails closed when an immutable archive checksum is invalid', async () => {
  const { sqlite, adapter } = memoryDatabase(['0001_initial.sql']);
  try {
    const payload = archive(2026, 3);
    sqlite.prepare("INSERT INTO weeks(id,season,week,phase,status,finalized_at) VALUES(1,2026,3,'REGULAR_SEASON','finalized','2026-09-29T00:00:00Z')").run();
    sqlite.prepare('INSERT INTO completed_week_archives(week_id,payload_json,checksum,finalized_at) VALUES(?,?,?,?)').run(1, payload, 'not-a-valid-checksum', '2026-09-29T00:00:00Z');

    await assert.rejects(buildCompletedHistory(adapter), /Archive digest mismatch/);
  } finally {
    sqlite.close();
  }
});

test('public completed history is available only while D1 owns the completed archive', async () => {
  const { sqlite, adapter } = memoryDatabase(['0001_initial.sql', '0009_admin_record_history.sql']);
  try {
    const payload = archive(2026, 3);
    sqlite.prepare("INSERT INTO weeks(id,season,week,phase,status,finalized_at) VALUES(1,2026,3,'REGULAR_SEASON','finalized','2026-09-29T00:00:00Z')").run();
    sqlite.prepare('INSERT INTO completed_week_archives(week_id,payload_json,checksum,finalized_at) VALUES(?,?,?,?)').run(1, payload, checksum(payload), '2026-09-29T00:00:00Z');
    await assert.rejects(readCompletedHistory(adapter), /not active/);
    const inactive = await worker.fetch(new Request('https://example.test/?action=completed-history'), { DB: adapter, CORS_ORIGIN: '*' });
    assert.equal(inactive.status, 409);
    const inactiveRecords = await worker.fetch(new Request('https://example.test/?action=completed-history-records'), { DB: adapter, CORS_ORIGIN: '*' });
    assert.equal(inactiveRecords.status, 409);

    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    const history = await readCompletedHistory(adapter);
    assert.equal(history.weeks[0].week, 3);
    const response = await worker.fetch(new Request('https://example.test/?action=completed-history'), { DB: adapter, CORS_ORIGIN: '*' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).weeks[0].archiveChecksum, checksum(payload));
    const records = await readCompletedHistoryRecords(adapter);
    assert.equal(records.games[0].gameId, '2026-2027|3|1');
    const projected = await worker.fetch(new Request('https://example.test/?action=completed-history-records'), { DB: adapter, CORS_ORIGIN: '*' });
    assert.equal(projected.status, 200);
    assert.equal((await projected.json()).picks[0].result, 'win');
  } finally {
    sqlite.close();
  }
});

test('normalized completed-history export requires canonical CSV parity', async () => {
  const { sqlite, adapter } = memoryDatabase(['0001_initial.sql']);
  try {
    const payload = archive(2026, 3);
    sqlite.prepare("INSERT INTO weeks(id,season,week,phase,status,finalized_at) VALUES(1,2026,3,'REGULAR_SEASON','finalized','2026-09-29T00:00:00Z')").run();
    sqlite.prepare('INSERT INTO completed_week_archives(week_id,payload_json,checksum,finalized_at) VALUES(?,?,?,?)').run(1, payload, checksum(payload), '2026-09-29T00:00:00Z');
    const csv = 'Season,Week,Game Num,Game Date,Favorite,Spread,Underdog,Home,Away,Name,Pick,Best Bet,Fav Score,Und Score,Home Score,Away Score,Result,BB Result,Result Win,Result Loss,Result Push,BB Win,BB Loss,BB Push,Tiebreaker,Actual Tiebreak\n2026-2027,3,1,9/29/2026,BUF,3,mia,BUF,mia,Example,BUF,BUF,24,16,24,16,win,win,1,0,0,1,0,0,400,388\n';
    const result = await buildCompletedHistoryRecords(adapter, async () => csv);
    assert.equal(result.games, 1);
    assert.equal(result.picks, 1);
    await assert.rejects(buildCompletedHistoryRecords(adapter, async () => csv.replace(',24,16,24,16,', ',24,16,23,16,')), /field homeScore/);
  } finally {
    sqlite.close();
  }
});