CREATE TABLE notification_observations (
  week_id INTEGER PRIMARY KEY REFERENCES weeks(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE notification_locks (
  name TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

ALTER TABLE notification_subscriptions RENAME COLUMN picks_due_minutes TO legacy_picks_due_minutes;
ALTER TABLE notification_subscriptions ADD COLUMN picks_due_minutes INTEGER NOT NULL DEFAULT 60 CHECK (picks_due_minutes BETWEEN 1 AND 240);
UPDATE notification_subscriptions SET picks_due_minutes = MAX(1, MIN(240, legacy_picks_due_minutes));
ALTER TABLE notification_subscriptions DROP COLUMN legacy_picks_due_minutes;