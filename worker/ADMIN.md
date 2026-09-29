# Private administration and candidate lifecycle

The owner has approved replacing Sheets input/payout editing with a private
interface. The first interface is local-only and uses the owner's cached
Wrangler authentication to reach cloud D1. The computer is needed while editing,
not for the scheduled observer or the existing hosted publisher.

## Current authority

**Rehearsal only. Sheets and Apps Script remain authoritative.** Administrative
records do not feed public standings, submissions, payouts, alerts, or the ETL.
Do not flip `admin_control.owner` as a cutover procedure: the live Apps Script
writer is not fenced by this administrative epoch. Worker submissions, legacy
staging, and browser race writes now check ownership, but this does not fence
every production writer or constitute a live ownership handoff.

## September 29 lifecycle and ownership follow-up

The owner upgraded the account to Workers Paid. Cloudflare confirmed Standard
usage for FBP and the Golf Workers with no custom CPU override. A live FBP cron
completed with 42 ms CPU, no exceptions, and successful snapshot, card-sync and
candidate processing. This removes the Free plan's 10 ms constraint; it is not
a sustained-load certificate or a fix for upstream source timeouts.

The operational score refresh now uses approved kickoff timestamps and the
approved tiebreak game, preserves an open pregame week, rejects invalid scores
and regressive game states, and bounds ESPN fetches to 20 seconds. Transaction
guards reject changed ownership, changed weeks and newer score observations.
Under D1 ownership it handles approved playoff rounds as well as regular weeks.

Operational finalization supports all four playoff rounds. Rounds 1-3 do not
require a tiebreaker; the Super Bowl and regular weeks do. Archive insertion and
week finalization are atomic, preserve existing archives, and compare ownership,
game states, cards and picks again at commit. Concurrent edits leave the week
unfinalized for a fresh retry. This is the finalization primitive, not the complete
playoff entry, cumulative standings or publication workflow.

Legacy public snapshot polling stops under D1 ownership. In-flight snapshot,
shadow-card and candidate transactions carry the original Sheets ownership epoch;
the legacy cache refuses public reads while D1 owns the pool. Operational
regular-season alert feeds read D1 without a Sheets fallback and reject ownership
changes during loading. Playoff cards cannot enter the regular-season alert path.
Email transport still uses the existing relay, and all-writer dispatch/handoff
coordination remains required before cutover.

Verification: 88 backend tests passed, two optional live tests skipped; TypeScript,
frontend regressions, editor diagnostics and the production bundle dry run passed.
Worker version `67784d3d-2107-4467-a832-cef5cffde440` is deployed with the owner
still SHEETS, epoch 1, and operational writes disabled. The actual Week 3 archive
comparison still passes for 31 players, 16 games and tiebreaker 388. No new schema,
source-data edit, financial posting or test notification was needed.

## September 29 integration

Week 3's canonical CSV/JSON publication and actual D1 candidate final-result
comparison passed: 31 cards, 16 final games, and a 388-yard final tiebreaker.
This does not certify uninterrupted race coverage or probability-model parity.

Migration 0016 is applied in production. It preserves Best Bet independently of
the ordinary pick. New submissions must choose a selected team; legacy opposing
Best Bets remain readable, score independently, and survive unrelated corrections.
No archived source cards or historical files were rewritten.

The 31 preserved Week 3 originals are now mapped into operational D1 tables with
their real source times, unchanged picks/Best Bets/tiebreakers/week names, and
private administrative links. Mapping is transactional, defaults to a dry run,
rejects an existing conflicting operational field, and checks source versions,
slate and ownership at commit. Replay inserted zero cards. Post-import recovery
exactly restored 45 total operational cards, 720 picks and 31 links; this remains
an isolated operational restore, not a live Sheets writeback rollback.

```sh
node scripts/admin-server.mjs --remote --map-originals=2026:3
node scripts/admin-server.mjs --remote --map-originals=2026:3 --apply-originals
node scripts/operational-source-import.mjs --rehearse=2026:3 --checkpoint=PRIVATE_CHECKPOINT
node scripts/admin-server.mjs --remote --operational-backup=NEW_PRIVATE_CHECKPOINT
```

The public client checks `backend-status` before submission. D1 submissions retain
operation IDs and the original expected card ID across lost responses and reloads;
owner/epoch changes stop the attempt. Lookup exposes metadata, not hidden playoff
picks. D1 live reads and payouts never fall back to Sheets. Current D1 payouts
require accepted integer-cent baselines; incomplete reconciliation fails closed.
Some staging, historical-race and season-status client paths still use Apps Script.
Do not treat the owner-aware client as permission to change the owner flag.

Verification: 82 backend tests passed, two optional live tests skipped, TypeScript
passed, frontend regressions passed. A mocked real-browser lost-response/reload
test resent exactly the same operation and reached confirmation, with no page
exceptions or overflow at 1440px/390px. No real test entry or email was sent.
Keep `OPERATIONAL_WRITES_ENABLED=false`, owner SHEETS and epoch 1 until all remaining
handoff, financial, lifecycle, rollback and CPU-capacity requirements are met.

The verified initial import contains 69 submitted cards, 660 season/player payout
records across 21 seasons, and five compressed original worksheet documents.
Original timestamp strings/raw values, formulas, display values, worksheet IDs,
and timezone are retained. Observation times are not substituted for submission
times. Historical corrections that were never retained at source cannot be
reconstructed. Import refuses ambiguous identities and overwriting existing edits.

The five initial financial discrepancies were resolved using explicit owner
decisions on 2026-09-24. The live source ledger has reconciliation acknowledgements,
and the corresponding D1 balances have audited opening-balance acceptances.
Original discrepancies and revisions remain intact. Private financial details and
receipts stay outside this public repository. No automatic financial adjustment
or duplicate cash transfer is inferred from an old ledger mismatch.

## Run the editor

From `worker/`, after `npm ci`:

```sh
node scripts/admin-server.mjs --remote --port=8811
```

Open `http://127.0.0.1:8811`. This server binds only loopback, validates Host and
Origin, requires same-origin JSON writes, does not enable CORS, and serves no
public edit API. Treat the local OS account as trusted. Do not expose the port
through a tunnel, bind it to a network address, or deploy `wrangler.admin.toml`.
That file exists only for local authenticated remote bindings.

`--demo --port=8810` uses disposable SQLite and synthetic data. The UI has input
and payout tabs, search/season filters, required edit reasons, version conflicts,
idempotent operation IDs, and revision history. The source documents are not
exposed by the editor API. Successful saves explicitly remain rehearsal edits.

The direct reconciliation view is `http://127.0.0.1:8811/?view=payout&review=1`.
Sample sessions have a distinct browser title. Payout balances are read-only in
the generic editor: accept an opening balance, then use the transaction form for
payments, prize credits, credit payouts or explicit adjustments. Reasons and
confirmation are required. Transactions use integer cents, expected versions and
epochs, retry-safe operation IDs, and an immutable journal inserted atomically
with the administrative event. No transaction in this editor writes live Sheets.
Only one form can hold unsaved changes at a time.

Migration `0012_submission_admin_projection.sql` supports explicit links between
administrative records and operational submissions. Linked corrections update
the real card and its correction audit in the same transaction, preserve the
original submission timestamp, validate matchup/Best Bet picks, and reject closed
or superseded cards. This path requires D1 ownership. The 31 Week 3 production
links now exist, but corrections remain fenced while Sheets owns the pool.

## Week 3 continuity safeguards

The public form and its Apps Script endpoint remain unchanged. Production must
keep `OPERATIONAL_WRITES_ENABLED=false` and `admin_control.owner=SHEETS` while
Week 3 is collecting or scoring picks. The Worker refuses replacement submissions
unless both deployment configuration and database ownership permit them. Public
Worker name corrections are disabled; operational corrections use the private
editor and its audited, version-checked projection.

Migration `0015` blocks a Sheets-to-D1 ownership change while an observed source
week remains unfinished, or before a complete open/live/finalized source cycle
exists. This is an additional guard, not authorization to switch when it passes:
the observer may lag, and the remaining cutover requirements below still apply.

Fresh source captures can add newly arrived original cards without overwriting
existing copies. Changed or missing source records stop the refresh for explicit
reconciliation. Unchanged records retain their original provenance. Always take
a new read-only source capture; replaying an old capture cannot detect arrivals
after its capture time.

```sh
node scripts/admin-server.mjs --remote --import=PRIVATE_SOURCE_FILE --refresh-submissions --season=2026 --week=3
```

The report compares each selected-week record, not only totals. A successful
report describes that capture, not a frozen source or a safe ownership handoff.
Do not run the destructive legacy operational importer against the active week.

The disabled replacement writer supports atomic cards/picks/receipts/editor
links, stable retry IDs, expected-current-card checks, commit-time ownership and
slate checks, and the existing late-new-player exception. Field limits match the
live form. Private week approval validates ordered matchups and an explicit fixed
playoff roster; hidden playoff reads reveal only after all eligible entries or
kickoff. These paths have synthetic coverage, but the approval interface, public
entry client and cumulative archive workflow are not complete. The operational
round finalization primitive is covered by the follow-up above.

## Private import and recovery

The private automation repository's `export_admin_source.py` reads Sheets with a
read-only OAuth scope and refuses an export if a tab's formulas/values change
during capture. This is not a transaction spanning the entire workbook. Store
exports outside every public checkout and protect them as private financial data.

```sh
node scripts/admin-import.mjs --check=PRIVATE_SOURCE_FILE
node scripts/admin-server.mjs --remote --import=PRIVATE_SOURCE_FILE
node scripts/admin-server.mjs --remote --import=PRIVATE_SOURCE_FILE --source-ledgers-only
node scripts/admin-server.mjs --remote --backup=NEW_PRIVATE_CHECKPOINT_FILE
node scripts/admin-checkpoint.mjs --rehearse=PRIVATE_CHECKPOINT_FILE
```

The import is additive and retryable, never the destructive legacy current-week
importer. The checkpoint verifies records against their complete revision chains.
Recovery rehearsals use empty in-memory SQLite, preserve intervening edits, check
the checksum, and increment the epoch. Existing recovery data is never overwritten.
Source-only imports preserve new immutable worksheet snapshots without replacing
edited cards or balances. Checkpoints include the payout journal; restore rebuilds
it from the ordered events and verifies the exact journal. This is administrative
record recovery, not a live Sheets ownership rollback or operational database backup.

The private automation utility `payout_adjustments.py` can post an explicitly
approved source reconciliation and winner allocation. It previews by default,
backs up private data before `--apply`, checks the current rows again, and updates
only approved Payout cells plus appended ledger entries in one Sheets batch.
Stable references detect retries and partial pre-existing postings. Sheets has
no compare-and-swap here: this is a supervised operation, not a concurrent public
write bridge. Do not run alongside another payout writer. It sends no email and
disburses no cash. Prize credit and prepaid allocation are separate ledger entries.

## Unattended candidate evidence

### Week 3 pre-final checks (2026-09-28)

The scheduled observer stalled at 2026-09-29 01:18:49 UTC despite later public
read-pair writes. Read-only source replay with all 31 cards passes in isolated
SQLite. Production logs identify both 35-second source timeouts and an
`exceededCpu` termination (21 ms measured CPU). Source reads now retry one
timeout/abort/network failure, with fresh URLs and unchanged freshness rules;
permission errors still fail immediately. Stage logs contain only week/time
metadata. Worker 559586c3-6278-48e1-a4ba-0bbc47c37d65 deployed this change with
operational writes disabled. Observation subsequently advanced to 03:08:49 UTC
and 205 frames, but that does not establish sustained health or repair missing
frames. CPU capacity remains an unresolved operational requirement. The cached
OAuth credential cannot read billing subscriptions; no billing was changed.

Read-only diagnostics (from `worker/`, Node 24):

```sh
node scripts/check-candidate-observer.mjs
node scripts/check-candidate-observer.mjs --compare-final=2026:3
```

The first command reads snapshots and existing candidate records from D1, then
replays processing only in memory. It reports source age; replay success does
not mean production is healthy. The second checks the actual immutable D1
archive checksum against the published latest-completed-week JSON. It compares
ordered games/lines/kickoffs/final scores, normalized cards, final tiebreaker and
win/loss records. Missing archives or another published week report `pending`;
corrupt or differing results fail. It does not compare the CSV directly, certify
probability/race parity, or authorize cutover. `fullReplacementReady` stays false.
Neither command writes production records or sends email.

`CANDIDATE_LIFECYCLE_ENABLED=true` enables a separate candidate observer in the
existing one-minute snapshot job. It reuses the validated source games/cards but
computes its own score and probability frames, at most one frame per five-minute
bucket. Sampled paths are labeled as sampled. It does not accept browser race
probabilities. Source fetches still depend on Apps Script; this is not independent
NFL ingestion or a completed backend replacement.

Only final game states plus a final tiebreaker can create regular-season archives.
Missing cards/tiebreakers do not finalize. Candidate archives are checksummed and
database-protected against update/delete. Changed slates and changed finalized
results require explicit reconciliation. Failures are logged but cannot stop the
public read snapshots, existing race refresh, or notification job.

Tests rehearse open/live/finalized states, transactional failure, all four playoff
rounds (6/4/2/1 games), the doubled Super Bowl pick, prior-round completion, late
new-player submissions, and reveal rules. Deadline/reveal helpers are not yet
wired into the legacy public write API or a production playoff entry interface.
The observer's staged flag is source-staged evidence, not a new owner approval UI.

## Still required before cutover

- Connect validated administrative changes to the operational submission/payout
  model and public consumers. Transaction journaling and linked correction
  projection are implemented; safe original-record mapping, operational imports,
  prepaid-period editing and full consumer integration are still required.
- Fence every real writer, including Apps Script, and prove a rollback that
  preserves intervening live submissions/corrections. An admin-only epoch is not enough.
- Complete production playoff staging/eligibility/reveal/entry and archive wiring.
- Observe an entire real staged/live/finalized regular-season cycle and compare
  its final archive with the canonical publisher, including final tiebreak values.
- Retain original history and export checkpoints before each ownership transition.

`fullReplacementReady` remains false. Resolving the financial baseline and passing
synthetic fixtures do not replace writer fencing or a real completed-cycle observation.