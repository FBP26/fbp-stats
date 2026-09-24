import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from './helpers/d1.mjs';

test('an accidental owner flip cannot interrupt an open or live source week',()=>{
  const {sqlite}=memoryDatabase(['0009_admin_record_history.sql','0010_candidate_lifecycle.sql','0015_active_week_cutover_guard.sql']);
  try{
    assert.throws(()=>sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2"),/no complete observed source cycle/);
    sqlite.exec("INSERT INTO candidate_weeks(season,week,phase,slate_hash,status,observed_open,observed_live,read_started_at,latest_json) VALUES(2026,3,'REGULAR_SEASON','fixture','open',1,0,1,'{}')");
    assert.throws(()=>sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2"),/still accepting or scoring picks/);
    sqlite.exec("UPDATE candidate_weeks SET status='live',observed_live=1");
    assert.throws(()=>sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2"),/still accepting or scoring picks/);
    assert.deepEqual({...sqlite.prepare('SELECT owner,epoch FROM admin_control').get()},{owner:'SHEETS',epoch:1});
  }finally{sqlite.close();}
});