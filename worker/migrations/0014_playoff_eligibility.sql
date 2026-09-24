CREATE TABLE playoff_eligibility (
  season INTEGER NOT NULL,
  player_name TEXT NOT NULL COLLATE NOCASE,
  approved_operation TEXT NOT NULL REFERENCES operational_receipts(operation_id),
  PRIMARY KEY (season, player_name)
);
CREATE TRIGGER playoff_eligibility_no_update BEFORE UPDATE ON playoff_eligibility
BEGIN SELECT RAISE(ABORT, 'Approved playoff roster is immutable'); END;
CREATE TRIGGER playoff_eligibility_no_delete BEFORE DELETE ON playoff_eligibility
BEGIN SELECT RAISE(ABORT, 'Approved playoff roster is immutable'); END;