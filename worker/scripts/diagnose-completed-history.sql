SELECT
  w.week,
  w.status,
  COUNT(DISTINCT g.id) AS staged_games,
  COUNT(DISTINCT s.id) AS active_submissions,
  COUNT(DISTINCT a.week_id) AS archive_count
FROM weeks w
LEFT JOIN games g ON g.week_id = w.id
LEFT JOIN submissions s ON s.week_id = w.id AND s.superseded_at IS NULL
LEFT JOIN completed_week_archives a ON a.week_id = w.id
WHERE w.season = 2026 AND w.week IN (1, 2) AND w.phase = 'REGULAR_SEASON'
GROUP BY w.id
ORDER BY w.week;

SELECT
  w.week,
  json_array_length(a.payload_json, '$.games') AS archived_games,
  (SELECT COUNT(*) FROM json_each(a.payload_json, '$.games') WHERE json_extract(value, '$.state') = 'FINAL') AS archived_final_games,
  (SELECT COUNT(*) FROM json_each(a.payload_json, '$.games') WHERE json_extract(value, '$.favoriteScore') IS NOT NULL AND json_extract(value, '$.underdogScore') IS NOT NULL) AS archived_scored_games,
  json_array_length(a.payload_json, '$.submissions') AS archived_submissions,
  a.finalized_at
FROM completed_week_archives a
JOIN weeks w ON w.id = a.week_id
WHERE w.season = 2026 AND w.week IN (1, 2)
ORDER BY w.week;

SELECT
  kind,
  operation_id,
  reason,
  recorded_at,
  json_extract(body, '$.season') AS season,
  json_extract(body, '$.week') AS week
FROM admin_events
WHERE CAST(json_extract(body, '$.season') AS INTEGER) = 2026
  AND CAST(json_extract(body, '$.week') AS INTEGER) IN (1, 2)
ORDER BY recorded_at DESC
LIMIT 30;

SELECT name
FROM sqlite_master
WHERE type = 'table' AND name LIKE '%archive%'
ORDER BY name;