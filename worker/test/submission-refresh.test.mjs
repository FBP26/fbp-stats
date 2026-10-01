import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from './helpers/d1.mjs';
import { importSourceRecords, refreshSourceSubmissions, reconcileSubmissionWeek } from '../scripts/admin-import.mjs';
import { saveAdminRecord } from '../src/admin-store.ts';
import { importOperationalOriginals, sourceSubmissionTime, parseCompletedArchive, importCompletedOperationalSlate } from '../scripts/operational-source-import.mjs';
import { validateAdminChanges } from '../scripts/admin-server.mjs';

const record = (suffix, checksum='original') => ({kind:'submission',recordId:`submission:${suffix}`,body:{name:suffix,season:'2026-2027',week:3,submittedAt:'2026-09-24T19:00:00.123Z',submittedAtRaw:'2026-09-24T19:00:00.123Z',picks:['BUF'],bestBet:'BUF',tiebreaker:400,provenance:{ledgerChecksum:checksum}}});

test('submissions arriving during migration are added without duplicating or overwriting existing originals',async()=>{
  const {sqlite,adapter}=memoryDatabase(['0009_admin_record_history.sql']);
  try{
    await importSourceRecords(adapter,[record('first')]);
    const result=await refreshSourceSubmissions(adapter,[record('first','new-snapshot'),record('arrived-during-work')]);
    assert.equal(result.inserted,1);assert.equal(result.unchanged,1);
    assert.equal((await refreshSourceSubmissions(adapter,[record('first','new-snapshot'),record('arrived-during-work')])).inserted,0);
    assert.equal(JSON.parse(sqlite.prepare("SELECT body FROM admin_records WHERE record_id='submission:first'").get().body).provenance.ledgerChecksum,'original');
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_events').get().total,2);
    const stored=sqlite.prepare('SELECT kind,record_id,body FROM admin_records').all();
    const report=reconcileSubmissionWeek([record('first'),record('arrived-during-work')],stored,2026,3);
    assert.equal(report.complete,true);assert.equal(report.matched,2);
    assert.equal(reconcileSubmissionWeek([record('first'),record('arrived-during-work'),record('even-later')],stored,2026,3).complete,false);
    assert.equal(reconcileSubmissionWeek([],[],2026,3).complete,false);
  }finally{sqlite.close();}
});

test('missing source cards or conflicting owner edits block reconciliation without altering any existing card',async()=>{
  const {sqlite,adapter}=memoryDatabase(['0009_admin_record_history.sql']);
  try{
    await importSourceRecords(adapter,[record('first')]);
    await assert.rejects(refreshSourceSubmissions(adapter,[record('new')]),/1 missing/);
    await saveAdminRecord(adapter,{kind:'submission',recordId:'submission:first',operationId:'owner-edit-preserved',expectedEpoch:1,expectedVersion:1,reason:'Owner correction',body:{...record('first').body,tiebreaker:500}},'owner');
    await assert.rejects(refreshSourceSubmissions(adapter,[record('first'),record('new')]),/1 changed/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_records').get().total,1);
    assert.equal(JSON.parse(sqlite.prepare('SELECT body FROM admin_records').get().body).tiebreaker,500);
  }finally{sqlite.close();}
});

test('preserved originals map atomically with real times, opposing Best Bets and replay protection', async () => {
  const { sqlite, adapter } = memoryDatabase(['0001_initial.sql','0009_admin_record_history.sql','0012_submission_admin_projection.sql','0016_independent_best_bet.sql']);
  try {
    sqlite.exec(`INSERT INTO weeks(id,season,week,phase,status) VALUES(1,2026,3,'REGULAR_SEASON','open');
      INSERT INTO games(id,week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team) VALUES(1,1,0,'1','2026-09-27T17:00:00Z','BUF','mia',3,'BUF','MIA');`);
    const original = record('Example');
    original.body.weekName = 'None'; original.body.bestBet = 'MIA';
    assert.equal(validateAdminChanges(original.body, { weekName: 'Corrected' }, 'submission').bestBet, 'MIA');
    assert.throws(() => validateAdminChanges(original.body, { bestBet: 'PIT' }, 'submission'), /Invalid/);
    await importSourceRecords(adapter, [original]);
    assert.equal((await importOperationalOriginals(adapter, 2026, 3)).productionWrites, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
    sqlite.exec("CREATE TRIGGER fail_mapping BEFORE INSERT ON submission_picks BEGIN SELECT RAISE(ABORT,'forced mapping failure'); END;");
    await assert.rejects(importOperationalOriginals(adapter, 2026, 3, { apply: true }), /forced mapping/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM admin_events').get().total, 1);
    sqlite.exec('DROP TRIGGER fail_mapping');
    assert.equal((await importOperationalOriginals(adapter, 2026, 3, { apply: true })).inserted, 1);
    assert.equal((await importOperationalOriginals(adapter, 2026, 3, { apply: true })).inserted, 0);
    const saved = sqlite.prepare('SELECT * FROM submissions').get();
    assert.equal(saved.submitted_at, original.body.submittedAtRaw);
    assert.equal(saved.best_bet_team, 'mia');
    assert.equal(sqlite.prepare('SELECT picked_team FROM submission_picks').get().picked_team, 'BUF');
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    await assert.rejects(importOperationalOriginals(adapter, 2026, 3, { apply: true }), /Sheets ownership/);
  } finally { sqlite.close(); }
});

test('Sheets serial timestamps preserve milliseconds and reject ambiguous daylight-saving times', () => {
  const serial = value => (Date.parse(value) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.equal(sourceSubmissionTime({ submittedAtRaw: serial('2026-09-24T15:00:00.123Z'), timeZone: 'America/New_York' }), '2026-09-24T19:00:00.123Z');
  assert.equal(sourceSubmissionTime({ submittedAtRaw: serial('2026-01-24T15:00:00.123Z'), timeZone: 'America/New_York' }), '2026-01-24T20:00:00.123Z');
  assert.throws(() => sourceSubmissionTime({ submittedAtRaw: serial('2026-11-01T01:30:00Z'), timeZone: 'America/New_York' }), /ambiguous/);
  assert.throws(() => sourceSubmissionTime({ submittedAtRaw: serial('2026-03-08T02:30:00Z'), timeZone: 'America/New_York' }), /invalid/);
  assert.throws(() => sourceSubmissionTime({ submittedAt: 'Observation time only' }), /missing/);
});

test('completed CSV slates preserve original times, reject conflicts and import atomically', async () => {
  const csv = 'Season,Week,Game Num,Game Date,Game Time,Favorite,Underdog,Spread,Home,Away,Fav Score,Und Score,Name,Week Name,Pick,Best Bet,Tiebreaker,Actual Tiebreak\n2026-2027,3,1,9/27/2026,1:00 PM,BUF,mia,3,BUF,mia,20,10,Example,None,BUF,mia,400,388\n';
  assert.equal(parseCompletedArchive(csv).games[0].kickoff, '2026-09-27T17:00:00.000Z');
  const awayFavorite = parseCompletedArchive(csv.replace('BUF,mia,3,BUF,mia', 'buf,MIA,3,MIA,buf').replace('None,BUF,mia', 'None,buf,MIA'));
  assert.equal(awayFavorite.games[0].favorite, 'buf');
  assert.equal(awayFavorite.games[0].awayScore, 20);
  assert.equal(awayFavorite.games[0].homeScore, 10);
  assert.equal(parseCompletedArchive(csv.replace('1:00 PM', '')).games[0].kickoff, null);
  assert.equal(parseCompletedArchive(csv.replace('1:00 PM', '')).games[0].kickoffPrecision, 'date');
  assert.throws(() => parseCompletedArchive(csv.replace('1:00 PM', '25:00')), /kickoff/);
  assert.throws(() => parseCompletedArchive(csv.replace(',388\n', ',\n')), /tiebreaker/);
  assert.throws(() => parseCompletedArchive(csv.replace('9/27/2026', '9/31/2026')), /date/);
  assert.throws(() => parseCompletedArchive(csv + csv.split('\n')[1] + '\n'), /Duplicate/);
  const { sqlite, adapter } = memoryDatabase(['0001_initial.sql','0009_admin_record_history.sql','0012_submission_admin_projection.sql','0016_independent_best_bet.sql']);
  try {
    const original = record('Example');
    original.body.weekName = 'None'; original.body.bestBet = 'MIA';
    await importSourceRecords(adapter, [original]);
    assert.equal((await importCompletedOperationalSlate(adapter, csv)).productionWrites, 0);
    await assert.rejects(importCompletedOperationalSlate(adapter, csv.replace(',400,388', ',401,388'), { apply: true }), /disagree/);
    sqlite.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON completed_week_archives BEGIN SELECT RAISE(ABORT,'forced archive failure'); END");
    await assert.rejects(importCompletedOperationalSlate(adapter, csv, { apply: true }), /forced archive failure/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM weeks').get().total, 0);
    sqlite.exec('DROP TRIGGER fail_archive');
    assert.equal((await importCompletedOperationalSlate(adapter, csv, { apply: true })).inserted, 1);
    assert.equal((await importCompletedOperationalSlate(adapter, csv, { apply: true })).inserted, 0);
    assert.equal((await importOperationalOriginals(adapter, 2026, 3, { apply: true })).inserted, 1);
    const saved = JSON.parse(sqlite.prepare('SELECT payload_json FROM completed_week_archives').get().payload_json);
    assert.equal(saved.submissions[0].submittedAt, original.body.submittedAtRaw);
    assert.equal(saved.submissions[0].weekName, 'None');
    assert.equal(saved.games[0].status, 'FINAL');
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    sqlite.exec('UPDATE game_states SET favorite_score=21');
    await assert.rejects(importCompletedOperationalSlate(adapter, csv, { apply: true }), /no longer matches/);
  } finally { sqlite.close(); }
});