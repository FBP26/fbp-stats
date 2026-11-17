-- "Fix my picks": the phone or browser that submitted a player's picks for a week keeps a private edit key.
-- Once a player's entry has a key, replacing it needs that key (or FBP Admin). Only the SHA-256 of the key is stored.
CREATE TABLE IF NOT EXISTS submission_edit_keys (
  week_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (week_id, player_id, key_hash)
);
