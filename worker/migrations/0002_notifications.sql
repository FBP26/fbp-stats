CREATE TABLE notification_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  destination TEXT NOT NULL,
  normalized_destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'unsubscribed')),
  verification_token_hash TEXT,
  manage_token_hash TEXT NOT NULL,
  picks_ready INTEGER NOT NULL DEFAULT 1 CHECK (picks_ready IN (0, 1)),
  first_place INTEGER NOT NULL DEFAULT 0 CHECK (first_place IN (0, 1)),
  early_window INTEGER NOT NULL DEFAULT 0 CHECK (early_window IN (0, 1)),
  late_window INTEGER NOT NULL DEFAULT 0 CHECK (late_window IN (0, 1)),
  before_snf INTEGER NOT NULL DEFAULT 0 CHECK (before_snf IN (0, 1)),
  before_mnf INTEGER NOT NULL DEFAULT 0 CHECK (before_mnf IN (0, 1)),
  weekly_result INTEGER NOT NULL DEFAULT 1 CHECK (weekly_result IN (0, 1)),
  verified_at TEXT,
  unsubscribed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verification_sent_at TEXT,
  UNIQUE (channel, normalized_destination)
);

CREATE INDEX notification_subscriptions_active_events
ON notification_subscriptions (status, channel);

CREATE TABLE notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES notification_subscriptions(id) ON DELETE CASCADE,
  week_id INTEGER REFERENCES weeks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  deduplication_key TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  UNIQUE (subscription_id, deduplication_key)
);

CREATE INDEX notification_deliveries_week_event
ON notification_deliveries (week_id, event_type, status);
