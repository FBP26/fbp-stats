CREATE TABLE submission_confirmation_outbox (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  operation_id TEXT NOT NULL UNIQUE,
  destination TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed')) DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX submission_confirmation_outbox_status ON submission_confirmation_outbox(status, created_at);