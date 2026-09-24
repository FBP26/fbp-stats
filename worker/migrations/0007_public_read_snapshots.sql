CREATE TABLE public_read_snapshots (
  name TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  read_started_at INTEGER NOT NULL,
  payload BLOB NOT NULL
);