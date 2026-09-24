CREATE TABLE admin_submission_links (
  record_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'submission' CHECK (kind = 'submission'),
  submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id),
  FOREIGN KEY (kind, record_id) REFERENCES admin_records(kind, record_id)
);

CREATE TRIGGER project_administrative_submission AFTER INSERT ON admin_events
WHEN NEW.kind = 'submission' AND EXISTS (SELECT 1 FROM admin_submission_links WHERE record_id = NEW.record_id)
BEGIN
  SELECT RAISE(ABORT, 'Operational corrections are fenced while Sheets owns submissions') WHERE NOT EXISTS (
    SELECT 1 FROM admin_control WHERE id = 1 AND owner = 'D1' AND epoch = NEW.epoch
  );
  SELECT RAISE(ABORT, 'Closed or superseded submissions cannot be corrected') WHERE EXISTS (
    SELECT 1 FROM submissions JOIN admin_submission_links ON submissions.id = submission_id
    JOIN weeks ON weeks.id = submissions.week_id
    WHERE record_id = NEW.record_id AND (weeks.status IN ('finalizing', 'finalized') OR submissions.superseded_at IS NOT NULL)
  );
  SELECT RAISE(ABORT, 'Correction does not match the operational slate') WHERE json_array_length(NEW.body, '$.picks') != (
    SELECT count(*) FROM games JOIN submissions ON submissions.week_id = games.week_id
    JOIN admin_submission_links ON submission_id = submissions.id WHERE record_id = NEW.record_id
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.body, '$.picks') AS pick
    JOIN admin_submission_links AS link ON link.record_id = NEW.record_id
    JOIN submissions ON submissions.id = link.submission_id
    JOIN games ON games.week_id = submissions.week_id AND games.game_index = pick.key
    WHERE upper(pick.value) NOT IN (upper(games.favorite), upper(games.underdog))
  ) OR NOT EXISTS (
    SELECT 1 FROM json_each(NEW.body, '$.picks') AS pick WHERE upper(pick.value) = upper(json_extract(NEW.body, '$.bestBet'))
  );
  INSERT INTO players(canonical_name) VALUES (trim(json_extract(NEW.body, '$.name'))) ON CONFLICT DO NOTHING;
  INSERT INTO submission_corrections(submission_id, field, old_value, new_value, reason, corrected_at)
    SELECT submission_id, 'admin-card', admin_records.body, NEW.body, NEW.reason, NEW.recorded_at
    FROM admin_submission_links JOIN admin_records USING(record_id, kind) WHERE record_id = NEW.record_id;
  UPDATE submissions SET
    player_id = (SELECT id FROM players WHERE canonical_name = trim(json_extract(NEW.body, '$.name')) COLLATE NOCASE),
    week_name = json_extract(NEW.body, '$.weekName'),
    tiebreaker = json_extract(NEW.body, '$.tiebreaker'),
    best_bet_game_index = (SELECT key FROM json_each(NEW.body, '$.picks') WHERE upper(value) = upper(json_extract(NEW.body, '$.bestBet')) LIMIT 1)
    WHERE id = (SELECT submission_id FROM admin_submission_links WHERE record_id = NEW.record_id);
  UPDATE submission_picks SET picked_team = (
    SELECT iif(upper(json_extract(NEW.body, '$.picks[' || games.game_index || ']')) = upper(games.favorite),
      games.favorite, games.underdog) FROM games WHERE games.id = submission_picks.game_id
  ) WHERE submission_id = (SELECT submission_id FROM admin_submission_links WHERE record_id = NEW.record_id);
END;