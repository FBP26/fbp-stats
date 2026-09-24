CREATE TABLE operational_receipts (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TRIGGER operational_receipt_owner BEFORE INSERT ON operational_receipts
BEGIN
  SELECT RAISE(ABORT, 'Operational ownership changed; retry with the current owner')
  WHERE NOT EXISTS (SELECT 1 FROM admin_control WHERE id = 1 AND owner = 'D1' AND epoch = NEW.epoch);
END;

CREATE TRIGGER operational_receipt_no_update BEFORE UPDATE ON operational_receipts
BEGIN SELECT RAISE(ABORT, 'Operational receipt is immutable'); END;
CREATE TRIGGER operational_receipt_no_delete BEFORE DELETE ON operational_receipts
BEGIN SELECT RAISE(ABORT, 'Operational receipt is immutable'); END;