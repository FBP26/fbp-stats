-- Payout grid moved from the Google Sheet "payout" tab into D1.
-- Each season block keeps the Sheet's exact layout: one row per sheet row, cells B..U as a JSON array of strings.
CREATE TABLE IF NOT EXISTS payout_rows (
  season INTEGER NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('title', 'periods', 'fees', 'player', 'champion', 'total', 'note')),
  label TEXT NOT NULL,
  cells_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, position)
);
CREATE INDEX IF NOT EXISTS payout_rows_player ON payout_rows (season, kind, label COLLATE NOCASE);

-- Every change to the payout grid, automatic or by hand, is one ledger row.
-- balance_change_cents > 0 means the player owes more; < 0 means the pool owes the player more.
CREATE TABLE IF NOT EXISTS payout_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  season INTEGER NOT NULL,
  player TEXT NOT NULL,
  type TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT '',
  money_in_cents INTEGER NOT NULL DEFAULT 0,
  money_out_cents INTEGER NOT NULL DEFAULT 0,
  balance_change_cents INTEGER NOT NULL DEFAULT 0,
  balance_after_cents INTEGER,
  reference TEXT NOT NULL UNIQUE,
  notes TEXT NOT NULL DEFAULT '',
  cell_old TEXT,
  cell_new TEXT,
  source TEXT NOT NULL DEFAULT 'admin'
);
CREATE INDEX IF NOT EXISTS payout_ledger_player ON payout_ledger (season, player COLLATE NOCASE, id);

-- Which finalized weeks have been charged/credited in the grid, and whether the owner winner email went out.
CREATE TABLE IF NOT EXISTS payout_settlements (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  settled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  winner_email_sent_at TEXT,
  PRIMARY KEY (season, week)
);

-- Failed admin sign-ins, for a simple lockout.
CREATE TABLE IF NOT EXISTS admin_login_failures (
  client TEXT NOT NULL,
  failed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_login_failures_client ON admin_login_failures (client, failed_at);

-- One row per owner email or health problem, so the daily health check can report it.
CREATE TABLE IF NOT EXISTS ops_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  reported_at TEXT
);
CREATE INDEX IF NOT EXISTS ops_events_unreported ON ops_events (reported_at, occurred_at);

-- Small key/value store for once-only owner emails (missing-picks reminder, daily health check).
CREATE TABLE IF NOT EXISTS ops_flags (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
