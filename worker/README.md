# FBP API Worker

Cloudflare Worker + D1 replacement for mutable Google Sheets and Apps Script state.
The database-backed API preserves many Apps Script `action` routes, but it is
not yet a proven drop-in replacement for the live Sheets backend. Do not change
submission or scoring ownership until migration parity and rollback are proven.

## Fast public reads

`action=public-read&kind=active-week`, `kind=current-week`, and
`kind=current-week-race&season=2026&week=3` serve compressed, read-only copies of
the existing public Apps Script responses. They do not use the D1 scoring engine
or import any submissions. Migration `0007` adds only `public_read_snapshots`.

The one-minute cron refreshes this cache independently of notification dispatch.
Slate and standings must match in season, week, game order and locked spreads
before an atomic update; older overlapping refreshes cannot overwrite newer ones.
Race refresh failure does not invalidate fresh slate or standings. Snapshots older
than 90 seconds from the start of the source read are rejected with HTTP 503.
Oversized compressed payloads are rejected instead of exceeding D1 row limits.

The frontend allows 1.5 seconds for a fresh snapshot, then falls back to Apps
Script. It deduplicates concurrent reads without sharing mutable player objects.
After an accepted submission it bypasses snapshots for two minutes, including
across page reloads. Other viewers and direct Sheet edits are eventually reflected
by the next successful refresh; this cache does not make the underlying score
collector run faster. No write, identity, email, or private preference API is cached.
Weather remains a separate background read.

Live starts known-week race reads alongside standings and rejects an old-week
prefetch after rollover. Probability and scenario calculations remain unchanged.
The regular D1 `active-week` and `current-week` routes are NOT these cache routes.

Validation: `npm run check`, `npm test`, and `node ../test-picks-reliability.mjs`.
Set `FBP_SNAPSHOT_SOURCE_URL` to the public Apps Script URL to opt into the
in-memory live-feed snapshot test; no production database writes occur in it.
Rollback the frontend snapshot helper to direct Apps Script reads if needed;
there is no need to remove the additive cache table or change live data ownership.

## Prerequisites

Install a current Node.js LTS release, then authenticate Wrangler:

```powershell
npm install
npx wrangler login
npx wrangler d1 create fbp
```

Copy the returned database ID into `wrangler.toml`, then initialize and validate:

```powershell
npm run db:migrate:local
npm run check
npm run dev
```

Apply the same migration remotely before deployment:

```powershell
npm run db:migrate:remote
npm run deploy
```

## Importing the active week

Prepare a reviewable SQL snapshot from the production Apps Script API:

```powershell
npm run import:prepare
```

The command refuses to import when no regular-season week is staged or when a
player card is incomplete. It writes ignored output to
`.generated/current-week.sql`. Review that file, validate it against local D1,
then explicitly apply the same file remotely:

```powershell
npm run db:import:local
npm run db:import:remote
```

An explicitly staged preseason week can be prepared for local parity testing:

```powershell
node scripts/import-current-week.mjs --phase PRESEASON --season 2026 --week 4 --skip-invalid-test-cards
npm run db:import:local
```

The skip flag exists only for seeded preseason cards that intentionally test
invalid tiebreaker values; regular-season imports cannot use it. Do not apply a
preseason rehearsal remotely unless that test data is intentionally needed in
the production database.

Compare Apps Script with a local preseason Worker after import:

```powershell
npm run parity -- --target http://127.0.0.1:8787 --phase PRESEASON --season 2026 --week 4 --skip-invalid-test-cards
```

For regular season, `npm run parity` compares `active-week` first and safely
defers `current-week` until a week is staged. After importing that staged week,
the same command compares the full current payload against the deployed Worker.
Request-time weather condition, temperature, source, and link fields are ignored;
game identity, spread, status, score, clock, possession, and player scoring are
still compared.

Measure the worst-case probability calculation against the current 16-game
preseason payload with `npm run benchmark:scoring`. Re-run this against the
regular Week 1 payload before enabling server-side scheduled snapshots on the
Workers Free 10 ms CPU allowance.

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

Do not switch the production frontend until imported D1 results match the Apps
Script payloads for a staged week, a live week, and a finalized week.
