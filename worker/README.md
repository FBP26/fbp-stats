# FBP API Worker

The FBP backend: picks, live scoring, week setup, notifications, payouts and FBP Admin, on Cloudflare Workers + D1.
Apps Script is only used as a Gmail relay for owner and notification emails.

## Local checks

```bash
npm ci
npm run check
npm test
```

Deploys go through GitHub Actions (see below); there is no need to run `wrangler deploy` by hand.

## How the live week works

Regular `current-week` responses perform only deterministic completed-game
scoring and return `probabilitySource: "client"`. The website's existing
`websitePreparePlayers()` engine calculates live probabilities and paths in the
browser, avoiding duplicate server enumeration and stale imported snapshots.

After calculating the field, the website can POST `action: "race-snapshot"`
with `season`, `week`, and every player's `name`, `winProbability`, and
`pathsToVictory`. The Worker requires the exact active regular-season field,
validates probabilities and paths, supplies win percentages and game state from
D1, and skips an unchanged frame. This keeps expensive probability enumeration
in the browser while making D1 the durable race-history owner.

The Worker cron runs every five minutes. It exits after one D1 read when no
regular week is active or outside the staged games' date window. During the game
window it refreshes each stored ESPN event directly by ID, batches game state and
metadata updates into D1, and records the final game's combined net passing yards.
When every game first becomes final, the week enters `finalizing` for one cron
interval so a browser can persist the final race frame. The next successful cron
stores a checksummed, immutable `week-archive` payload and atomically marks the
week `finalized`. `finalize_fbp_week.py --endpoint <worker-url>` can consume that
payload without Google Sheets.

## FBP Admin and payouts

- Admin page: `https://fbp-api.fbp-api-worker.workers.dev/admin` (username `Jim`, password = the `FBP_ADMIN_PASSWORD` GitHub secret, pushed to the Worker on every deploy).
- The payout grid and ledger live in D1 (`payout_rows`, `payout_ledger`, `payout_settlements`); the Google Sheet payout tab is a frozen copy as of the cutover.
- Deploys: `.github/workflows/deploy-worker.yml` (main -> production, other branches -> `fbp-api-staging`). Do not run `wrangler d1 migrations apply --remote`: production's migration history does not match this folder; apply new migration files with `wrangler d1 execute --file`.
- Backups: `.github/workflows/d1-backup.yml` -> private R2 bucket `fbp-backups/d1/` (120 days). A permanent copy from before the Nov 17 2026 table cleanup is at `fbp-backups/archive/pre-cleanup-2026-11-17.sql.gz`.
- Week lines: ESPN scoreboard odds (DraftKings), with Yahoo's scoreboard page as a fallback for any game ESPN has no line for.
