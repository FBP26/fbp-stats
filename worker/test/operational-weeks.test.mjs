import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from './helpers/d1.mjs';
import { approveOperationalWeek, operationalPicksVisible } from '../src/operational-weeks.ts';
import { submitOperationalCard } from '../src/operational-submissions.ts';
import worker, { awardFinalizedRegularWeek, finalizeWeek, loadAlertFeed, refreshActiveGameStates, syncApprovedStagedWeek } from '../src/index.ts';
test('score refresh preserves approval, follows the approved tiebreaker and fences concurrent ownership changes', async () => {
  const { sqlite, adapter } = memoryDatabase(['0001_initial.sql','0009_admin_record_history.sql']);
  const refreshTime = new Date('2026-09-29T18:00:00Z');
  try {
    sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2; INSERT INTO weeks(id,season,week,phase,status,tiebreak_game_id) VALUES(1,2026,4,'REGULAR_SEASON','open','nfl.g.20260929001');");
    for (const [index, suffix] of ['999','001'].entries()) {
      sqlite.prepare('INSERT INTO games(week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team,metadata_json) VALUES(1,?,?,?,?,?,?,?,?,?)')
        .run(index, `nfl.g.20260929${suffix}`, '2026-09-29T17:00:00Z', 'BUF', 'pit', 3, 'BUF', 'PIT', JSON.stringify({ espnEventId: suffix }));
    }
    const source = (eventId, final) => ({ gamepackageJSON: {
      header: { competitions: [{ status: { type: { state: final ? 'post' : 'pre', completed: final } }, competitors: [
        { homeAway: 'home', score: final ? '24' : '', team: { abbreviation: 'BUF' } },
        { homeAway: 'away', score: final ? '17' : '', team: { abbreviation: 'PIT' } },
      ] }] },
      boxscore: { teams: [100, Number(eventId)].map(value => ({ statistics: [{ name: 'netPassingYards', value }] })) },
    } });
    assert.equal((await refreshActiveGameStates(adapter, async eventId => source(eventId, false), refreshTime)).refreshed, 2);
    assert.equal(sqlite.prepare('SELECT status FROM weeks').get().status, 'open');
    assert.equal((await refreshActiveGameStates(adapter, async eventId => source(eventId, true), refreshTime)).refreshed, 2);
    assert.equal(sqlite.prepare('SELECT tiebreak_actual FROM weeks').get().tiebreak_actual, 101);
    assert.equal((await refreshActiveGameStates(adapter, async eventId => source(eventId, false), refreshTime)).skipped, 'regressive-game-state');
    const before = sqlite.prepare('SELECT * FROM game_states ORDER BY game_id').all();
    const batch = adapter.batch;
    adapter.batch = async statements => { sqlite.exec("UPDATE admin_control SET owner='SHEETS',epoch=3"); return batch(statements); };
    assert.equal((await refreshActiveGameStates(adapter, async eventId => source(eventId, true), refreshTime)).skipped, 'ownership-or-week-changed');
    assert.deepEqual(sqlite.prepare('SELECT * FROM game_states ORDER BY game_id').all(), before);
    assert.equal(sqlite.prepare('SELECT status FROM weeks').get().status, 'finalizing');
    adapter.batch = async statements => {
      sqlite.exec("UPDATE game_states SET updated_at='2026-09-29T18:01:00Z',favorite_score=31");
      return batch(statements);
    };
    assert.equal((await refreshActiveGameStates(adapter, async eventId => source(eventId, true), refreshTime)).refreshed, 0);
    assert.equal(sqlite.prepare('SELECT min(favorite_score) AS score FROM game_states').get().score, 31);
  } finally { sqlite.close(); }
});

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
function fixture(){const memory=memoryDatabase(['0001_initial.sql','0009_admin_record_history.sql','0011_payout_journal.sql','0012_submission_admin_projection.sql','0013_operational_receipts.sql','0014_playoff_eligibility.sql','0016_independent_best_bet.sql']);memory.sqlite.exec("UPDATE admin_control SET owner='D1',epoch=2");return memory;}
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

test('approval prevents overlapping competitive phases even when another approval commits first', async () => {
  for (const activePhase of ['REGULAR_SEASON', 'PLAYOFFS']) {
    const { sqlite, adapter } = fixture();
    try {
      await approveOperationalWeek(adapter, { ...approval(1), phase: activePhase }, 'owner', now);
      const otherPhase = activePhase === 'PLAYOFFS' ? 'REGULAR_SEASON' : 'PLAYOFFS';
      await assert.rejects(approveOperationalWeek(adapter, { ...approval(1), operationId: 'overlapping-week-approval', phase: otherPhase }, 'owner', now), /active or existing week/);
      assert.equal(sqlite.prepare('SELECT count(*) AS total FROM weeks').get().total, 1);
      assert.equal(sqlite.prepare('SELECT count(*) AS total FROM operational_receipts').get().total, 1);
    } finally { sqlite.close(); }
  }
  const { sqlite, adapter } = fixture();
  try {
    const batch = adapter.batch;
    adapter.batch = async statements => {
      sqlite.exec("INSERT INTO weeks(season,week,phase,status) VALUES(2026,18,'REGULAR_SEASON','open')");
      return batch(statements);
    };
    await assert.rejects(approveOperationalWeek(adapter, approval(1), 'owner', now), /active or existing week/);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM operational_receipts').get().total, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM playoff_eligibility').get().total, 0);
  } finally { sqlite.close(); }
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
    for (const action of ['playoff-round','race-archive','week-archive','current-week','week-one']) {
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

test('playoff rounds refresh by approved kickoff and finalize without an early-round tiebreaker', async () => {
  const { sqlite, adapter } = fixture();
  try {
    for (const round of [1, 2, 3, 4]) {
      const slate = approval(round);
      slate.games = slate.games.map((game, index) => ({ ...game, espnEventId: String(index) }));
      await approveOperationalWeek(adapter, slate, 'owner', now);
      await submitOperationalCard(adapter, { operationId: `playoff-lifecycle-card-${round}`, name: 'Example', weekName: 'None', season: 2026, week: round, phase: 'PLAYOFFS', picks: slate.games.map(game => game.favorite), bestBet: 'BUF', tiebreaker: 400 }, now);
      const response = await worker.fetch(new Request('https://example.test/?action=active-week'), { DB: adapter, CORS_ORIGIN: '*' });
      assert.equal((await response.json()).phase, 'PLAYOFFS');
      const refreshed = await refreshActiveGameStates(adapter, async eventId => {
        const game = slate.games[Number(eventId)];
        return { gamepackageJSON: { header: { competitions: [{ status: { type: { state: 'post', completed: true } }, competitors: [
          { homeAway: 'home', score: '24', team: { abbreviation: game.home } },
          { homeAway: 'away', score: '17', team: { abbreviation: game.away } },
        ] }] } } };
      }, new Date('2027-01-10T21:00:00Z'));
      assert.equal(refreshed.refreshed, slate.games.length);
      let week = sqlite.prepare('SELECT * FROM weeks WHERE week=?').get(round);
      assert.equal(week.tiebreak_actual, null);
      if (round === 4) {
        assert.equal(await finalizeWeek(adapter, week), false);
        sqlite.prepare('UPDATE weeks SET tiebreak_actual=388 WHERE id=?').run(week.id);
        week = sqlite.prepare('SELECT * FROM weeks WHERE id=?').get(week.id);
      }
      assert.equal(await finalizeWeek(adapter, week), true);
      const archive = sqlite.prepare('SELECT * FROM completed_week_archives WHERE week_id=?').get(week.id);
      const payload = JSON.parse(archive.payload_json);
      assert.equal(payload.phase, 'PLAYOFFS');
      assert.equal(payload.actualTiebreaker, round === 4 ? 388 : null);
      assert.equal(payload.submissions[0].weekName, 'None');
      assert.equal(payload.submissions[0].tiebreaker, round === 4 ? 400 : null);
      assert.equal(await finalizeWeek(adapter, week), false);
      assert.deepEqual(sqlite.prepare('SELECT * FROM completed_week_archives WHERE week_id=?').get(week.id), archive);
    }
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM completed_week_archives').get().total, 4);
    const fees = sqlite.prepare("SELECT * FROM payout_journal WHERE transaction_type='ENTRY_FEE'").all();
    assert.equal(fees.length, 1);
    assert.equal(fees[0].amount_cents, 2000);
    assert.equal(fees[0].after_cents, 2000);
    assert.equal(fees[0].money_in_cents + fees[0].money_out_cents, 0);
  } finally { sqlite.close(); }
});

test('season status lists active originals, excludes preseason and uses the approved playoff roster', async () => {
  const { sqlite, adapter } = fixture();
  const env = { DB:adapter, CORS_ORIGIN:'*' };
  const request = () => worker.fetch(new Request('https://example.test/?action=season-status'), env);
  try {
    await approveOperationalWeek(adapter, { ...approval(1), phase:'REGULAR_SEASON' }, 'owner', now);
    const card = { operationId:'season-status-first-card', name:'Example', weekName:'None', season:2026, week:1, picks:games(6).map(game=>game.favorite), bestBet:'BUF', tiebreaker:400 };
    await submitOperationalCard(adapter, card, now);
    sqlite.exec("UPDATE weeks SET status='finalized'; INSERT INTO weeks(season,week,phase,status) VALUES(2026,1,'PRESEASON','open'); INSERT INTO players(canonical_name) VALUES('Test only'); INSERT INTO submissions(week_id,player_id,submitted_name,week_name,best_bet_game_index,tiebreaker,submitted_at) SELECT weeks.id,players.id,'Test only','Private test',0,400,'2026-08-01T12:00:00Z' FROM weeks,players WHERE phase='PRESEASON' AND canonical_name='Test only';");
    await approveOperationalWeek(adapter, { ...approval(1), operationId:'season-status-second-week', week:2, phase:'REGULAR_SEASON' }, 'owner', now);
    let response = await request();
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.deepEqual(body.notYetSubmittedCurrentWeek, ['Example']);
    assert.deepEqual(body.playedThisSeason, ['Example']);
    assert.deepEqual(body.submittedCurrentWeek, []);
    await submitOperationalCard(adapter, { ...card, operationId:'season-status-second-card', week:2 }, now);
    body = await (await request()).json();
    assert.deepEqual(body.notYetSubmittedCurrentWeek, []);
    assert.deepEqual(body.submittedCurrentWeek, ['Example']);
    assert.equal(JSON.stringify(body).includes('bestBet'), false);
    sqlite.exec("UPDATE weeks SET status='finalized' WHERE phase='REGULAR_SEASON'");
    await approveOperationalWeek(adapter, { ...approval(1), operationId:'season-status-playoff-week' }, 'owner', now);
    body = await (await request()).json();
    assert.equal(body.phase, 'PLAYOFFS');
    assert.deepEqual(body.notYetSubmittedCurrentWeek, ['Example','Other']);
    sqlite.exec("UPDATE admin_control SET owner='SHEETS',epoch=3");
    assert.equal((await request()).status, 409);
  } finally { sqlite.close(); }
});

test('finalization commits neither archive nor status across ownership or card changes', async () => {
  for (const change of ["UPDATE admin_control SET epoch=3", "UPDATE submissions SET week_name='Corrected'"]) {
    const { sqlite, adapter } = fixture();
    try {
      await approveOperationalWeek(adapter, approval(1), 'owner', now);
      await submitOperationalCard(adapter, { operationId: 'finalization-fenced-card', name: 'Example', weekName: 'None', season: 2026, week: 1, phase: 'PLAYOFFS', picks: games(6).map(game => game.favorite), bestBet: 'BUF' }, now);
      sqlite.exec("INSERT INTO game_states(game_id,state,favorite_score,underdog_score) SELECT id,'FINAL',24,17 FROM games; UPDATE weeks SET status='finalizing'");
      const week = sqlite.prepare('SELECT * FROM weeks').get();
      const batch = adapter.batch;
      adapter.batch = async statements => { sqlite.exec(change); return batch(statements); };
      assert.equal(await finalizeWeek(adapter, week), false);
      assert.equal(sqlite.prepare('SELECT count(*) AS total FROM completed_week_archives').get().total, 0);
      assert.equal(sqlite.prepare('SELECT status FROM weeks').get().status, 'finalizing');
    } finally { sqlite.close(); }
  }
});

test('D1 alerts read operational cards without Sheets and withhold cross-owner or playoff feeds', async () => {
  const { sqlite, adapter } = fixture();
  try {
    await approveOperationalWeek(adapter, { ...approval(1), phase: 'REGULAR_SEASON' }, 'owner', now);
    await submitOperationalCard(adapter, { operationId: 'operational-alert-feed-01', name: 'Example', weekName: 'None', season: 2026, week: 1, picks: games(6).map(game => game.favorite), bestBet: 'BUF', tiebreaker: 400 }, now);
    const week = sqlite.prepare('SELECT * FROM weeks').get();
    const env = { DB: adapter, CORS_ORIGIN: '*', PICKS_SOURCE_URL: 'https://example.test/sheets' };
    const unexpectedFetch = () => { throw new Error('Must not read Sheets'); };
    const feed = await loadAlertFeed(env, week, unexpectedFetch);
    assert.equal(feed.cards[0].name, 'Example');
    assert.equal(feed.cards[0].bestBet, 'BUF');
    assert.equal(feed.games.length, 6);
    await assert.rejects(loadAlertFeed(env, { ...week, phase: 'PLAYOFFS' }, unexpectedFetch), /playoff picks/);
    sqlite.exec("UPDATE admin_control SET owner='SHEETS',epoch=3");
    await assert.rejects(loadAlertFeed(env, week, async () => {
      sqlite.exec("UPDATE admin_control SET owner='D1',epoch=4");
      return Response.json({ ok: true, staged: true, season: 2026, week: 1, games: games(6).map(game => ({ ...game, status: 'PREGAME' })), players: [{ ...feed.cards[0], picks: feed.cards[0].picks }] });
    }), /ownership changed/);
  } finally { sqlite.close(); }
});

test('a finalized D1 regular week creates replay-safe reserve-aware award postings', async () => {
  const { sqlite, adapter } = fixture();
  try {
    sqlite.exec("INSERT INTO weeks(id,season,week,phase,status,tiebreak_actual) VALUES(1,2026,1,'REGULAR_SEASON','open',400); INSERT INTO games(id,week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team) VALUES(1,1,0,'award-game','2027-01-10T17:00:00Z','BUF','mia',3,'BUF','MIA');");
    for (const name of ['Amy', 'Bob', 'Zed']) await submitOperationalCard(adapter, { operationId: `award-card-${name}-0001`, name, weekName: 'None', season: 2026, week: 1, picks: ['BUF'], bestBet: 'BUF', tiebreaker: 400 }, now);
    sqlite.exec("INSERT INTO game_states(game_id,state,favorite_score,underdog_score) VALUES(1,'FINAL',24,17); UPDATE weeks SET status='finalized'");
    assert.equal((await awardFinalizedRegularWeek(adapter, sqlite.prepare('SELECT * FROM weeks').get())).awarded, 3);
    assert.equal((await awardFinalizedRegularWeek(adapter, sqlite.prepare('SELECT * FROM weeks').get())).awarded, 0);
    const awards = sqlite.prepare("SELECT * FROM payout_journal WHERE transaction_type='WEEKLY_AWARD' ORDER BY record_id").all();
    assert.equal(awards.length, 3);
    assert.equal(awards.reduce((total, row) => total + row.amount_cents, 0), 1000);
    const records = sqlite.prepare("SELECT body FROM admin_records WHERE kind='payout' ORDER BY record_id").all().map(row => JSON.parse(row.body));
    assert.deepEqual(records.map(record => record.weeks[0]), ['tie', 'tie', 'tie']);
  } finally { sqlite.close(); }
});