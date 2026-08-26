PRAGMA foreign_keys = ON;

CREATE TABLE weeks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('PRESEASON', 'REGULAR_SEASON', 'PLAYOFFS')),
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'open', 'live', 'finalizing', 'finalized')),
  tiebreak_game_id TEXT,
  tiebreak_actual REAL,
  staged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finalized_at TEXT,
  UNIQUE (season, week, phase)
);

CREATE UNIQUE INDEX one_active_regular_week
ON weeks ((phase))
WHERE phase = 'REGULAR_SEASON' AND status IN ('staged', 'open', 'live', 'finalizing');

CREATE TABLE games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  game_index INTEGER NOT NULL CHECK (game_index BETWEEN 0 AND 15),
  external_id TEXT NOT NULL,
  kickoff_at TEXT NOT NULL,
  favorite TEXT NOT NULL,
  underdog TEXT NOT NULL,
  spread REAL NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (week_id, game_index),
  UNIQUE (week_id, external_id)
);

CREATE TABLE game_states (
  game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('PREGAME', 'LIVE', 'FINAL')),
  favorite_score INTEGER,
  underdog_score INTEGER,
  period TEXT,
  clock TEXT,
  net_passing_yards REAL,
  source_updated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL REFERENCES weeks(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  submitted_name TEXT NOT NULL,
  week_name TEXT NOT NULL,
  best_bet_game_index INTEGER NOT NULL CHECK (best_bet_game_index BETWEEN 0 AND 15),
  tiebreaker REAL NOT NULL CHECK (tiebreaker BETWEEN -100 AND 1200),
  source TEXT NOT NULL DEFAULT 'website',
  submitted_at TEXT NOT NULL,
  superseded_at TEXT,
  UNIQUE (week_id, player_id, submitted_at)
);

CREATE UNIQUE INDEX one_current_submission_per_player_week
ON submissions (week_id, player_id)
WHERE superseded_at IS NULL;

CREATE TABLE submission_picks (
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  game_id INTEGER NOT NULL REFERENCES games(id),
  picked_team TEXT NOT NULL,
  PRIMARY KEY (submission_id, game_id)
);

CREATE TABLE submission_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  field TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  reason TEXT,
  corrected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE live_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (week_id, captured_at)
);

CREATE TABLE race_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  player_name TEXT NOT NULL,
  win_probability REAL NOT NULL,
  paths REAL NOT NULL,
  win_pct REAL,
  game_state_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX race_snapshots_week_time
ON race_snapshots (week_id, captured_at, player_name);

CREATE TABLE completed_week_archives (
  week_id INTEGER PRIMARY KEY REFERENCES weeks(id),
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  finalized_at TEXT NOT NULL
);

CREATE TABLE analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  browser_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('page_view', 'picks_started', 'submission')),
  view_name TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}'
);
