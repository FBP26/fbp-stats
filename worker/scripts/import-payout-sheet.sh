#!/usr/bin/env bash
# Copy the Google Sheet payout tabs into a D1 database, only if its payout grid is still empty.
# Usage: scripts/import-payout-sheet.sh <database-name>   (run from worker/, with Cloudflare credentials in env)
set -euo pipefail
DB="$1"
COUNT=$(npx wrangler d1 execute "$DB" --remote --json --command "SELECT COUNT(*) AS n FROM payout_rows" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].results[0].n))')
echo "payout_rows in $DB: $COUNT"
if [ "$COUNT" != "0" ]; then echo "Payout grid already in D1; skipping the Sheet import."; exit 0; fi
TMP="${RUNNER_TEMP:-/tmp}"
SHEET="https://docs.google.com/spreadsheets/d/19LkATudJU7W7bsnBBNy7iCI68P3Nhbt10XIJ5Q7HRCA/export?format=csv"
curl -sfL "$SHEET&gid=2" -o "$TMP/payout.csv"
curl -sfL "$SHEET&gid=394865541" -o "$TMP/ledger.csv"
python3 scripts/import-payout-sheet.py "$TMP/payout.csv" "$TMP/ledger.csv" "$TMP/import.sql" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
npx wrangler d1 execute "$DB" --remote --file "$TMP/import.sql" -y
