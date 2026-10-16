ALTER TABLE analytics_events ADD COLUMN country TEXT;
ALTER TABLE analytics_events ADD COLUMN region TEXT;
ALTER TABLE analytics_events ADD COLUMN region_code TEXT;
ALTER TABLE analytics_events ADD COLUMN continent TEXT;
ALTER TABLE analytics_events ADD COLUMN city TEXT;
ALTER TABLE analytics_events ADD COLUMN latitude REAL;
ALTER TABLE analytics_events ADD COLUMN longitude REAL;

CREATE INDEX analytics_events_geography_time
ON analytics_events (occurred_at DESC, latitude, longitude);
