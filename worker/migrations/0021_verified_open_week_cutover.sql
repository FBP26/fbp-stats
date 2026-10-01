CREATE TABLE d1_cutover_handoffs (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  phase TEXT NOT NULL,
  candidate_slate_hash TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  PRIMARY KEY (season, week, phase)
);

DROP TRIGGER refuse_active_week_cutover;

CREATE TRIGGER refuse_active_week_cutover BEFORE UPDATE OF owner ON admin_control
WHEN OLD.owner = 'SHEETS' AND NEW.owner = 'D1'
BEGIN
  SELECT RAISE(ABORT, 'Cutover blocked: a live source week is still accepting or scoring picks')
  WHERE EXISTS (
    SELECT 1
    FROM candidate_weeks AS candidate
    WHERE candidate.status != 'finalized'
      AND NOT EXISTS (
        SELECT 1
        FROM d1_cutover_handoffs AS handoff
        JOIN weeks AS operational
          ON operational.season = candidate.season
          AND operational.week = candidate.week
          AND operational.phase = candidate.phase
          AND operational.status IN ('open', 'live')
        WHERE handoff.season = candidate.season
          AND handoff.week = candidate.week
          AND handoff.phase = candidate.phase
          AND handoff.candidate_slate_hash = candidate.slate_hash
          AND json_array_length(candidate.latest_json, '$.games') = (
            SELECT count(*) FROM games WHERE week_id = operational.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(candidate.latest_json, '$.games') AS source_game
            WHERE NOT EXISTS (
              SELECT 1
              FROM games AS operational_game
              WHERE operational_game.week_id = operational.id
                AND operational_game.external_id = json_extract(source_game.value, '$.gameId')
                AND operational_game.kickoff_at = json_extract(source_game.value, '$.kickoff')
                AND operational_game.favorite = json_extract(source_game.value, '$.favorite')
                AND operational_game.underdog = json_extract(source_game.value, '$.underdog')
                AND operational_game.spread = json_extract(source_game.value, '$.spread')
            )
          )
      )
  );
  SELECT RAISE(ABORT, 'Cutover blocked: no complete observed source cycle exists')
  WHERE NOT EXISTS (
    SELECT 1
    FROM candidate_weeks
    JOIN candidate_archives USING(season, week, phase)
    WHERE candidate_weeks.status = 'finalized'
      AND observed_open = 1
      AND observed_live = 1
  );
END;