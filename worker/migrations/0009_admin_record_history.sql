CREATE TABLE admin_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL CHECK (owner IN ('SHEETS', 'D1')),
  epoch INTEGER NOT NULL CHECK (epoch > 0)
);
INSERT INTO admin_control VALUES (1, 'SHEETS', 1);

CREATE TABLE admin_events (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  epoch INTEGER NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE (kind, record_id, version)
);

CREATE TABLE admin_records (
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  operation_id TEXT NOT NULL REFERENCES admin_events(operation_id),
  body TEXT NOT NULL,
  PRIMARY KEY (kind, record_id)
);

CREATE INDEX admin_events_record_history ON admin_events(kind, record_id, version);

CREATE TRIGGER admin_events_no_update BEFORE UPDATE ON admin_events
BEGIN SELECT RAISE(ABORT, 'Administrative audit history is immutable'); END;
CREATE TRIGGER admin_events_no_delete BEFORE DELETE ON admin_events
BEGIN SELECT RAISE(ABORT, 'Administrative audit history is immutable'); END;