CREATE TABLE visitor_player_links (
  browser_id TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id),
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
