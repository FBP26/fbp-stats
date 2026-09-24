CREATE TABLE candidate_weeks (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('REGULAR_SEASON', 'PLAYOFFS')),
  slate_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'live', 'finalizing', 'finalized')),
  observed_open INTEGER NOT NULL DEFAULT 0,
  observed_live INTEGER NOT NULL DEFAULT 0,
  read_started_at INTEGER NOT NULL,
  latest_json TEXT NOT NULL,
  PRIMARY KEY (season, week, phase)
);

CREATE TABLE candidate_race_frames (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  phase TEXT NOT NULL,
  interval_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (season, week, phase, interval_id),
  FOREIGN KEY (season, week, phase) REFERENCES candidate_weeks(season, week, phase)
);

CREATE TABLE candidate_archives (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  phase TEXT NOT NULL,
  checksum TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  finalized_at INTEGER NOT NULL,
  PRIMARY KEY (season, week, phase),
  FOREIGN KEY (season, week, phase) REFERENCES candidate_weeks(season, week, phase)
);

CREATE TRIGGER candidate_archives_no_update BEFORE UPDATE ON candidate_archives
BEGIN SELECT RAISE(ABORT, 'Candidate archives are immutable'); END;
CREATE TRIGGER candidate_archives_no_delete BEFORE DELETE ON candidate_archives
BEGIN SELECT RAISE(ABORT, 'Candidate archives are immutable'); END;