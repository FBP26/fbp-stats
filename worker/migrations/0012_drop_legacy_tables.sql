-- Remove tables left over from the Apps Script -> D1 cutover, the old private payout ledger, and the
-- "shadow"/"candidate" dry-run machinery. Nothing in the Worker reads or writes them any more.
-- A full copy of the database taken just before this ran is kept in R2: fbp-backups/archive/pre-cleanup-2026-11-17.sql.gz
PRAGMA defer_foreign_keys = true;
DROP TABLE IF EXISTS admin_submission_links;
DROP TABLE IF EXISTS payout_journal;
DROP TABLE IF EXISTS admin_records;
DROP TABLE IF EXISTS admin_events;
DROP TABLE IF EXISTS admin_control;
DROP TABLE IF EXISTS operational_receipts;
DROP TABLE IF EXISTS candidate_race_frames;
DROP TABLE IF EXISTS candidate_archives;
DROP TABLE IF EXISTS candidate_weeks;
DROP TABLE IF EXISTS shadow_card_revisions;
DROP TABLE IF EXISTS shadow_card_heads;
DROP TABLE IF EXISTS shadow_sync_weeks;
DROP TABLE IF EXISTS d1_cutover_handoffs;
DROP TABLE IF EXISTS public_read_snapshots;
DROP TABLE IF EXISTS playoff_eligibility;
DROP TABLE IF EXISTS submission_confirmation_outbox;
DROP TABLE IF EXISTS push_admin_devices;
INSERT INTO d1_migrations (name) SELECT '0012_drop_legacy_tables.sql' WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0012_drop_legacy_tables.sql');
