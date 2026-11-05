CREATE TABLE analytics_events_rebuilt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  browser_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('page_view', 'picks_started', 'submission', 'view_duration')),
  view_name TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  country TEXT,
  region TEXT,
  region_code TEXT,
  continent TEXT,
  city TEXT,
  latitude REAL,
  longitude REAL
);

INSERT INTO analytics_events_rebuilt (
  id, occurred_at, browser_id, session_id, event, view_name, context_json,
  country, region, region_code, continent, city, latitude, longitude
)
SELECT
  id, occurred_at, browser_id, session_id, event, view_name, context_json,
  country, region, region_code, continent, city, latitude, longitude
FROM analytics_events;

DROP TABLE analytics_events;
ALTER TABLE analytics_events_rebuilt RENAME TO analytics_events;

CREATE INDEX analytics_events_geography_time
ON analytics_events (occurred_at DESC, latitude, longitude);
