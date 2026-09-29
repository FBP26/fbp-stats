import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from './helpers/d1.mjs';
import { approveOperationalWeek, operationalPicksVisible } from '../src/operational-weeks.ts';
import { submitOperationalCard } from '../src/operational-submissions.ts';
import worker, { syncApprovedStagedWeek } from '../src/index.ts';
test('legacy staging is atomic and cannot cross ownership or fabricate prior finalization', async () => {
  const { sqlite, adapter } = memoryDatabase(['0001_initial.sql','0009_admin_record_history.sql','0010_candidate_lifecycle.sql']);
  const env = { DB: adapter, CORS_ORIGIN: '*' };
  const payload = { season: 2026, week: 3, games: [{ gameId: '1', kickoff: '2026-09-27T17:00:00Z', favorite: 'BUF', underdog: 'mia', home: 'BUF', away: 'MIA', spread: 3 }] };
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");
    await assert.rejects(syncApprovedStagedWeek(payload, env), /Legacy staging/);
    sqlite.exec("UPDATE admin_control SET owner='SHEETS',epoch=3");
    const batch = adapter.batch;
    adapter.batch = async statements => { sqlite.exec("UPDATE admin_control SET owner='D1',epoch=4"); return batch(statements); };
    await assert.rejects(syncApprovedStagedWeek(payload, env), /fenced/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM weeks').get().total, 0);
    adapter.batch = batch;
    sqlite.exec("UPDATE admin_control SET owner='SHEETS',epoch=5");
    await syncApprovedStagedWeek(payload, env);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM games').get().total, 1);
    await assert.rejects(syncApprovedStagedWeek({ ...payload, week: 4 }, env), /unfinished prior week/);
    assert.equal(sqlite.prepare('SELECT status FROM weeks').get().status, 'staged');
    sqlite.exec("CREATE TRIGGER fail_legacy_game BEFORE INSERT ON games BEGIN SELECT RAISE(ABORT,'forced staging failure'); END;");
    await assert.rejects(syncApprovedStagedWeek(payload, env), /forced staging/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM games').get().total, 1);
  } finally { sqlite.close(); }
});

const now='2026-09-24T19:00:00Z';
const teams=['BUF','MIA','PIT','BAL','KC','DEN','NYG','NYJ','SEA','LAR','DAL','PHI'];
const games=count=>Array.from({length:count},(_,index)=>({gameId:`game-${index}`,kickoff:'2027-01-10T17:00:00Z',favorite:teams[index*2],underdog:teams[index*2+1].toLowerCase(),home:teams[index*2],away:teams[index*2+1],spread:3}));
function fixture(){const memory=memoryDatabase(['0001_initial.sql','0009_admin_record_history.sql','0012_submission_admin_projection.sql','0013_operational_receipts.sql','0014_playoff_eligibility.sql','0016_independent_best_bet.sql']);memory.sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");return memory;}
const approval=round=>({operationId:`playoff-approval-round-${round}`,expectedEpoch:2,season:2026,week:round,phase:'PLAYOFFS',reason:'Owner approved slate and roster',eligiblePlayers:['Example','Other'],games:games([6,4,2,1][round-1])});

test('owner approves four immutable rounds; prior-round completion and fixed roster are mandatory',async()=>{
  const {sqlite,adapter}=fixture();
  try{
    await assert.rejects(approveOperationalWeek(adapter,approval(2),'owner',now),/previous playoff round/);
    for(const round of [1,2,3,4]){
      await approveOperationalWeek(adapter,approval(round),'owner',now);
      assert.equal((await approveOperationalWeek(adapter,approval(round),'owner',now)).replayed,true);
      assert.equal(sqlite.prepare('SELECT count(*) AS total FROM games JOIN weeks ON weeks.id=week_id WHERE week=?').get(round).total,[6,4,2,1][round-1]);
      await assert.rejects(approveOperationalWeek(adapter,{...approval(round),operationId:`different-approval-${round}`},'owner',now),/active or existing week/);
      sqlite.prepare("UPDATE weeks SET status='finalized' WHERE week=?").run(round);
    }
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM playoff_eligibility').get().total,2);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{sqlite.close();}
});

test('eligible entries reveal only when complete or kicked off, without requiring a pre-Super-Bowl tiebreaker',async()=>{
  const {sqlite,adapter}=fixture();
  try{
    await approveOperationalWeek(adapter,approval(1),'owner',now);
    const card={operationId:'playoff-card-example-01',name:'Example',weekName:'None',season:2026,week:1,phase:'PLAYOFFS',picks:games(6).map(game=>game.favorite),bestBet:'BUF'};
    assert.equal(await operationalPicksVisible(adapter,1,now),false);
    await assert.rejects(submitOperationalCard(adapter,{...card,name:'Unapproved'},now),/approved playoff roster/);
    await submitOperationalCard(adapter,card,now);
    assert.equal(await operationalPicksVisible(adapter,1,now),false);
    for (const action of ['playoff-round','race-archive','archive-week']) {
      const response=await worker.fetch(new Request(`https://example.test/?action=${action}&season=2026&week=1&phase=PLAYOFFS`),{DB:adapter,CORS_ORIGIN:'*'});
      const body=await response.json();
      assert.equal(body.picksVisible,false);
      assert.deepEqual(body.players,[]);
      assert.equal(JSON.stringify(body).includes('Example'),false);
    }
    assert.equal(await operationalPicksVisible(adapter,1,'2027-01-10T17:00:00Z'),true);
    await submitOperationalCard(adapter,{...card,name:'Other',operationId:'playoff-card-other-0001'},now);
    assert.equal(await operationalPicksVisible(adapter,1,now),true);
  }finally{sqlite.close();}
});