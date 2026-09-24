# Private administration and candidate lifecycle

The owner has approved replacing Sheets input/payout editing with a private
interface. The first interface is local-only and uses the owner's cached
Wrangler authentication to reach cloud D1. The computer is needed while editing,
not for the scheduled observer or the existing hosted publisher.

## Current authority

**Rehearsal only. Sheets and Apps Script remain authoritative.** Administrative
records do not feed public standings, submissions, payouts, alerts, or the ETL.
Do not flip `admin_control.owner` as a cutover procedure: the live Apps Script
writer and legacy Worker writers do not yet consult this administrative epoch.
The epoch currently fences administrative mutations, not every production writer.

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
or superseded cards. This path requires D1 ownership. No production submission
links have been activated; this is not an operational import or a write cutover.

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
entry client, playoff finalization and cumulative archive workflow are not complete.

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