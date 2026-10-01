import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase } from './helpers/d1.mjs';
import { saveAdminRecord } from '../src/admin-store.ts';
import { reconcileExistingCompletedOperationalSlate } from '../scripts/operational-source-import.mjs';

const csv = `Season,Week,Game Num,Game Date,Game Time,Favorite,Spread,Underdog,Home,Away,Name,Week Name,Pick,Best Bet,Fav Score,Und Score,Tiebreaker,Actual Tiebreak
2026-2027,2,1,9/17/2026,8:15 PM,BUF,3,mia,BUF,mia,Example,Original,BUF,BUF,24,16,400,388
`;

async function fixture() {
  const memory = memoryDatabase(['0001_initial.sql', '0009_admin_record_history.sql', '0012_submission_admin_projection.sql', '0016_independent_best_bet.sql']);
  const { sqlite, adapter } = memory;
  sqlite.exec(`INSERT INTO weeks(id,season,week,phase,status,tiebreak_actual) VALUES(1,2026,2,'REGULAR_SEASON','finalized',388);
    INSERT INTO games(id,week_id,game_index,external_id,kickoff_at,favorite,underdog,spread,home_team,away_team) VALUES(1,1,0,'espn-1','2026-09-18T00:15:00.000Z','BUF','mia',3,'BUF','MIA');
    INSERT INTO game_states(game_id,state,favorite_score,underdog_score) VALUES(1,'FINAL',24,16);
    INSERT INTO players(id,canonical_name) VALUES(1,'Example');
    INSERT INTO submissions(id,week_id,player_id,submitted_name,week_name,best_bet_game_index,best_bet_team,tiebreaker,source,submitted_at) VALUES(1,1,1,'Example','Original',0,'BUF',400,'source-original','2026-09-16T16:00:00.000Z');
    INSERT INTO submission_picks(submission_id,game_id,picked_team) VALUES(1,1,'BUF');`);
  await saveAdminRecord(adapter, {
    kind: 'submission', recordId: 'submission:example', operationId: 'source-card-example', expectedVersion: 0, expectedEpoch: 1, reason: 'Source import',
    body: { name: 'Example', weekName: 'Original', picks: ['BUF'], bestBet: 'BUF', tiebreaker: 400,
      submittedAtRaw: '2026-09-16T16:00:00.000Z', season: '2026-2027', week: 2 },
  }, 'source');
  return { sqlite, adapter };
}

test('completed archive reconciliation only inserts a verified immutable archive for an existing finalized slate', async () => {
  const { sqlite, adapter } = await fixture();
  try {
    assert.deepEqual(await reconcileExistingCompletedOperationalSlate(adapter, csv), { season: 2026, week: 2, games: 1, cards: 1, safe: true, productionWrites: 0, sourceWrites: 0 });
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM completed_week_archives').get().total, 0);
    assert.deepEqual(await reconcileExistingCompletedOperationalSlate(adapter, csv, { apply: true }), { season: 2026, week: 2, inserted: 1, sourceWrites: 0 });
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM completed_week_archives').get().total, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM submissions').get().total, 1);
    assert.deepEqual(await reconcileExistingCompletedOperationalSlate(adapter, csv, { apply: true }), { season: 2026, week: 2, inserted: 0, replayed: true, sourceWrites: 0 });
  } finally { sqlite.close(); }
});