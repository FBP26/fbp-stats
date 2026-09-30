CREATE TABLE push_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_token TEXT NOT NULL UNIQUE,
  device_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unsubscribed')),
  picks_ready INTEGER NOT NULL DEFAULT 1 CHECK (picks_ready IN (0, 1)),
  picks_due INTEGER NOT NULL DEFAULT 1 CHECK (picks_due IN (0, 1)),
  picks_due_minutes INTEGER NOT NULL DEFAULT 60 CHECK (picks_due_minutes BETWEEN 5 AND 300),
  first_place INTEGER NOT NULL DEFAULT 0 CHECK (first_place IN (0, 1)),
  early_window INTEGER NOT NULL DEFAULT 0 CHECK (early_window IN (0, 1)),
  late_window INTEGER NOT NULL DEFAULT 0 CHECK (late_window IN (0, 1)),
  before_snf INTEGER NOT NULL DEFAULT 0 CHECK (before_snf IN (0, 1)),
  before_mnf INTEGER NOT NULL DEFAULT 0 CHECK (before_mnf IN (0, 1)),
  weekly_result INTEGER NOT NULL DEFAULT 1 CHECK (weekly_result IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unsubscribed_at TEXT
);

CREATE INDEX push_devices_active_events ON push_devices (status);

CREATE TABLE push_device_players (
  device_id INTEGER NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id, player_name)
);

CREATE INDEX push_device_players_player ON push_device_players (player_name COLLATE NOCASE);

CREATE TABLE push_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  week_id INTEGER REFERENCES weeks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  deduplication_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  UNIQUE (device_id, deduplication_key)
);

CREATE INDEX push_deliveries_week_event ON push_deliveries (week_id, event_type, status);

UPDATE notification_subscriptions
SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
WHERE channel = 'email' AND status IN ('active', 'pending');