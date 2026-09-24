import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from './helpers/d1.mjs';
import { importSourceRecords, refreshSourceSubmissions, reconcileSubmissionWeek } from '../scripts/admin-import.mjs';
import { saveAdminRecord } from '../src/admin-store.ts';

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