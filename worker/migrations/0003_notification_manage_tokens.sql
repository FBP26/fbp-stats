ALTER TABLE notification_subscriptions ADD COLUMN manage_token TEXT;

CREATE UNIQUE INDEX notification_subscriptions_manage_token
ON notification_subscriptions (manage_token)
WHERE manage_token IS NOT NULL;
