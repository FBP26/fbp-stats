CREATE TABLE payout_journal (
  operation_id TEXT PRIMARY KEY REFERENCES admin_events(operation_id),
  record_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  before_cents INTEGER NOT NULL,
  after_cents INTEGER NOT NULL,
  money_in_cents INTEGER NOT NULL,
  money_out_cents INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (record_id, version)
);

CREATE TRIGGER payout_posting AFTER INSERT ON admin_events
WHEN NEW.kind = 'payout' AND json_extract(NEW.body, '$.posting.operationId') = NEW.operation_id
BEGIN
  SELECT RAISE(ABORT, 'Payout posting balance conflict') WHERE json_extract(NEW.body, '$.posting.beforeCents') != COALESCE(
    (SELECT json_extract(body, '$.balanceCents') FROM admin_events WHERE kind = 'payout' AND record_id = NEW.record_id AND version = NEW.version - 1), 0)
  ;
  INSERT INTO payout_journal VALUES (
    NEW.operation_id, NEW.record_id, NEW.version,
    json_extract(NEW.body, '$.posting.type'), json_extract(NEW.body, '$.posting.amountCents'),
    json_extract(NEW.body, '$.posting.beforeCents'), json_extract(NEW.body, '$.balanceCents'),
    json_extract(NEW.body, '$.posting.moneyInCents'), json_extract(NEW.body, '$.posting.moneyOutCents'), NEW.recorded_at
  );
END;

CREATE TRIGGER payout_balance_requires_posting BEFORE INSERT ON admin_events
WHEN NEW.kind = 'payout' AND EXISTS (
  SELECT 1 FROM admin_records WHERE kind = 'payout' AND record_id = NEW.record_id
    AND json_type(body, '$.balanceCents') = 'integer'
) AND (
  json_extract(NEW.body, '$.balanceCents') IS NOT (SELECT json_extract(body, '$.balanceCents') FROM admin_records WHERE kind = 'payout' AND record_id = NEW.record_id)
  OR json_extract(NEW.body, '$.balance') IS NOT (SELECT json_extract(body, '$.balance') FROM admin_records WHERE kind = 'payout' AND record_id = NEW.record_id)
) AND json_extract(NEW.body, '$.posting.operationId') IS NOT NEW.operation_id
BEGIN SELECT RAISE(ABORT, 'A payout balance change requires an audited posting'); END;

CREATE TRIGGER payout_journal_no_update BEFORE UPDATE ON payout_journal
BEGIN SELECT RAISE(ABORT, 'Payout journal is immutable'); END;
CREATE TRIGGER payout_journal_no_delete BEFORE DELETE ON payout_journal
BEGIN SELECT RAISE(ABORT, 'Payout journal is immutable'); END;