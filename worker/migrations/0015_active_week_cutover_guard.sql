CREATE TRIGGER refuse_active_week_cutover BEFORE UPDATE OF owner ON admin_control
WHEN OLD.owner = 'SHEETS' AND NEW.owner = 'D1'
BEGIN
  SELECT RAISE(ABORT, 'Cutover blocked: a live source week is still accepting or scoring picks')
  WHERE EXISTS (SELECT 1 FROM candidate_weeks WHERE status != 'finalized');
  SELECT RAISE(ABORT, 'Cutover blocked: no complete observed source cycle exists')
  WHERE NOT EXISTS (SELECT 1 FROM candidate_weeks JOIN candidate_archives USING(season,week,phase)
    WHERE candidate_weeks.status = 'finalized' AND observed_open = 1 AND observed_live = 1);
END;