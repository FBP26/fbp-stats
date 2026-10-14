CREATE TABLE week_setup_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'REGULAR_SEASON' CHECK (phase IN ('REGULAR_SEASON', 'PLAYOFFS')),
  slate_hash TEXT NOT NULL,
  slate_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'expired', 'superseded')),
  approval_token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT,
  UNIQUE (season, week, phase, slate_hash)
);

CREATE INDEX week_setup_candidates_active
  ON week_setup_candidates (season, week, phase, status, expires_at);