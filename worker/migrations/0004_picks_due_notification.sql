ALTER TABLE notification_subscriptions ADD COLUMN picks_due INTEGER NOT NULL DEFAULT 1 CHECK (picks_due IN (0, 1));
ALTER TABLE notification_subscriptions ADD COLUMN picks_due_minutes INTEGER NOT NULL DEFAULT 120 CHECK (picks_due_minutes BETWEEN 5 AND 300);
