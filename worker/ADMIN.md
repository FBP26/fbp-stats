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

The current payout source has four ledger/balance mismatches and one nonzero
balance without a ledger entry. Both values are retained and flagged in the
editor. No balance was automatically reconciled. Resolve these privately before
financial ownership changes. Reconciliation status describes the import baseline;
editing a rehearsal balance does not certify a reconciled financial ledger.

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

## Private import and recovery

The private automation repository's `export_admin_source.py` reads Sheets with a
read-only OAuth scope and refuses an export if a tab's formulas/values change
during capture. This is not a transaction spanning the entire workbook. Store
exports outside every public checkout and protect them as private financial data.

```sh
node scripts/admin-import.mjs --check=PRIVATE_SOURCE_FILE
node scripts/admin-server.mjs --remote --import=PRIVATE_SOURCE_FILE
node scripts/admin-server.mjs --remote --backup=NEW_PRIVATE_CHECKPOINT_FILE
node scripts/admin-checkpoint.mjs --rehearse=PRIVATE_CHECKPOINT_FILE
```

The import is additive and retryable, never the destructive legacy current-week
importer. The checkpoint verifies records against their complete revision chains.
Recovery rehearsals use empty in-memory SQLite, preserve intervening edits, check
the checksum, and increment the epoch. Existing recovery data is never overwritten.
This is administrative-record recovery, not a live Sheets ownership rollback.

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

- Resolve the five current financial discrepancies with the owner.
- Connect validated administrative changes to the operational submission/payout
  model, including matchup-specific validation and audited ledger transactions.
- Fence every real writer, including Apps Script, and prove a rollback that
  preserves intervening live submissions/corrections. An admin-only epoch is not enough.
- Complete production playoff staging/eligibility/reveal/entry and archive wiring.
- Observe an entire real staged/live/finalized regular-season cycle and compare
  its final archive with the canonical publisher, including final tiebreak values.
- Retain original history and export checkpoints before each ownership transition.

`fullReplacementReady` remains false. The five financial discrepancies and a real
completed-cycle observation cannot be replaced by passing synthetic fixtures.