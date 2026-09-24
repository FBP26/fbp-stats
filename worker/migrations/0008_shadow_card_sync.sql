CREATE TABLE shadow_sync_weeks (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL CHECK (week BETWEEN 1 AND 18),
  observed_at INTEGER NOT NULL,
  source_updated_at TEXT,
  members_json TEXT NOT NULL,
  PRIMARY KEY (season, week)
);

CREATE TABLE shadow_card_revisions (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  player_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  submitted_at TEXT,
  card_json TEXT NOT NULL,
  PRIMARY KEY (season, week, player_key, revision_id)
);

CREATE TABLE shadow_card_heads (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  player_key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (season, week, player_key),
  FOREIGN KEY (season, week, player_key, revision_id)
    REFERENCES shadow_card_revisions (season, week, player_key, revision_id)
);