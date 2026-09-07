UPDATE notification_subscriptions
SET before_snf = 1,
    late_window = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE late_window = 1;