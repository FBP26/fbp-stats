import assert from "node:assert/strict";
import test from "node:test";

import { recordScheduledRaceSnapshot } from "../src/index.ts";
import { memoryDatabase } from "./helpers/d1.mjs";

test("scheduled race recorder stores a complete changed field once", async () => {
  const { sqlite, adapter } = memoryDatabase([
    "0001_initial.sql", "0002_notifications.sql", "0003_notification_manage_tokens.sql", "0004_picks_due_notification.sql",
    "0005_combine_sunday_notifications.sql", "0006_alert_observations.sql", "0007_public_read_snapshots.sql", "0008_shadow_card_sync.sql",
    "0009_admin_record_history.sql", "0010_candidate_lifecycle.sql", "0011_payout_journal.sql", "0012_submission_admin_projection.sql",
    "0013_operational_receipts.sql", "0014_playoff_eligibility.sql", "0015_active_week_cutover_guard.sql", "0016_independent_best_bet.sql",
  ]);
  try {
    sqlite.exec(`
      INSERT INTO weeks (id, season, week, phase, status) VALUES (1, 2026, 4, 'REGULAR_SEASON', 'live');
      INSERT INTO games (id, week_id, game_index, external_id, kickoff_at, favorite, underdog, spread, home_team, away_team)
        VALUES (1, 1, 0, 'nfl.g.20261001005', '2026-10-02T00:15:00.000Z', 'PIT', 'CLE', 2.5, 'CLE', 'PIT');
      INSERT INTO game_states (game_id, state, favorite_score, underdog_score, period, clock)
        VALUES (1, 'FINAL', 24, 27, '', '');
      INSERT INTO players (id, canonical_name) VALUES (1, 'Alpha'), (2, 'Bravo');
      INSERT INTO submissions (id, week_id, player_id, submitted_name, week_name, best_bet_game_index, best_bet_team, tiebreaker, submitted_at)
        VALUES (1, 1, 1, 'Alpha', 'A', 0, 'CLE', 400, '2026-10-01T12:00:00.000Z'),
               (2, 1, 2, 'Bravo', 'B', 0, 'PIT', 500, '2026-10-01T12:01:00.000Z');
      INSERT INTO submission_picks (submission_id, game_id, picked_team) VALUES (1, 1, 'cle'), (2, 1, 'PIT');
    `);
    const week = { id: 1, phase: "REGULAR_SEASON", status: "live", tiebreak_actual: null };
    assert.equal(await recordScheduledRaceSnapshot(adapter, week), true);
    assert.equal(sqlite.prepare("SELECT count(*) AS total FROM race_snapshots").get().total, 2);
    assert.deepEqual(sqlite.prepare("SELECT player_name, win_pct FROM race_snapshots ORDER BY player_name").all().map((row) => ({ ...row })), [
      { player_name: "Alpha", win_pct: 100 },
      { player_name: "Bravo", win_pct: 0 },
    ]);
    assert.equal(await recordScheduledRaceSnapshot(adapter, week), false);
    assert.equal(sqlite.prepare("SELECT count(*) AS total FROM race_snapshots").get().total, 2);
  } finally {
    sqlite.close();
  }
});