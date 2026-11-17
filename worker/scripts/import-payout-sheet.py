"""Build SQL that copies the Google Sheet "payout" and "payout ledger" tabs into D1 (payout_rows, payout_ledger,
payout_settlements). Usage: python3 import-payout-sheet.py payout.csv ledger.csv out.sql

payout.csv: https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=2
ledger.csv: same URL with gid=394865541
Replaces any rows already imported (the Sheet is the source of truth until the cutover).
"""
import csv
import json
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")
COLUMNS = 20


def sql(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(int(value)) if float(value).is_integer() else repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def cents(text):
    text = str(text or "").strip()
    if not text:
        return 0
    negative = text.startswith("-") or text.startswith("(")
    amount = float(re.sub(r"[^0-9.]", "", text) or 0)
    return -round(amount * 100) if negative else round(amount * 100)


def iso(text):
    text = str(text or "").strip()
    if not text:
        return None
    if "T" in text:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")
    stamp = datetime.strptime(text, "%m/%d/%Y %I:%M:%S %p").replace(tzinfo=EASTERN)
    return stamp.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")


def payout_rows(path):
    rows = list(csv.reader(open(path, encoding="utf-8")))
    starts = [index for index, row in enumerate(rows) if row and re.fullmatch(r"20\d\d", row[0].strip())]
    out = []
    for block, start in enumerate(starts):
        end = starts[block + 1] if block + 1 < len(starts) else len(rows)
        season = int(rows[start][0].strip())
        after_total = False
        for position, row in enumerate(rows[start:end]):
            label = (row[0] if row else "").strip() if position else str(season)
            cells = [str(cell) for cell in (row[1:] if row else [])][:COLUMNS]
            cells += [""] * (COLUMNS - len(cells))
            low = label.lower()
            if position == 0:
                kind = "title"
            elif low == "week":
                kind = "periods"
            elif low == "name":
                kind = "fees"
            elif "champion" in low and not after_total:
                kind = "champion"
            elif low == "total" and not after_total:
                kind, after_total = "total", True
            elif after_total or not label:
                kind = "note"
                label = (row[0] if row else "")
            else:
                kind = "player"
            out.append((season, position, kind, label, cells))
    return out


def ledger_rows(path):
    rows = list(csv.reader(open(path, encoding="utf-8")))
    header = rows[0]
    out = []
    for row in rows[1:]:
        if not any(cell.strip() for cell in row):
            continue
        item = dict(zip(header, row))
        season = int(str(item["Season"]).split("-")[0]) if item.get("Season") else None
        balance_after = item.get("Player Balance", "").strip()
        out.append({
            "recorded_at": iso(item["Recorded At"]),
            "effective_at": iso(item["Effective Date"]) or iso(item["Recorded At"]),
            "season": season,
            "player": item["Player"].strip(),
            "type": item["Type"].strip(),
            "period": item.get("Period", "").strip(),
            "money_in_cents": cents(item.get("Money In")),
            "money_out_cents": cents(item.get("Money Out")),
            "balance_change_cents": cents(item.get("Balance Change")),
            "balance_after_cents": cents(balance_after) if balance_after else None,
            "reference": item["Reference"].strip(),
            "notes": item.get("Notes", "").strip(),
        })
    return out


def main(payout_path, ledger_path, out_path):
    grid = payout_rows(payout_path)
    ledger = ledger_rows(ledger_path)
    seasons = sorted({season for season, *_ in grid})
    statements = ["DELETE FROM payout_rows;", "DELETE FROM payout_ledger WHERE source = 'sheet';"]
    for chunk in range(0, len(grid), 60):
        values = ",\n".join(
            f"({season}, {position}, {sql(kind)}, {sql(label)}, {sql(json.dumps(cells, ensure_ascii=False))})"
            for season, position, kind, label, cells in grid[chunk:chunk + 60]
        )
        statements.append(f"INSERT INTO payout_rows (season, position, kind, label, cells_json) VALUES\n{values};")
    seen = set()
    for chunk in range(0, len(ledger), 40):
        values = []
        for entry in ledger[chunk:chunk + 40]:
            reference = entry["reference"] or f"SHEET|{entry['recorded_at']}|{entry['player']}|{entry['type']}"
            while reference in seen:
                reference += "|dup"
            seen.add(reference)
            values.append("(" + ", ".join(sql(value) for value in [
                entry["recorded_at"], entry["effective_at"], entry["season"], entry["player"], entry["type"], entry["period"],
                entry["money_in_cents"], entry["money_out_cents"], entry["balance_change_cents"], entry["balance_after_cents"],
                reference, entry["notes"], "sheet",
            ]) + ")")
        statements.append(
            "INSERT INTO payout_ledger (recorded_at, effective_at, season, player, type, period, money_in_cents, money_out_cents, "
            "balance_change_cents, balance_after_cents, reference, notes, source) VALUES\n" + ",\n".join(values)
            + "\nON CONFLICT (reference) DO NOTHING;"
        )
    # Weeks the Sheet already settled (prize credited) count as settled, with the winner email already sent.
    settled = sorted({(int(m.group(1)), int(m.group(2))) for entry in ledger
                      for m in [re.match(r"PRIZE\|(\d{4})\|(\d+)\|", entry["reference"])] if m})
    for season, week in settled:
        statements.append(
            f"INSERT INTO payout_settlements (season, week, settled_at, winner_email_sent_at) VALUES ({season}, {week}, "
            "'imported from Sheet', 'sent by Apps Script') ON CONFLICT (season, week) DO NOTHING;"
        )
    open(out_path, "w", encoding="utf-8").write("\n".join(statements) + "\n")
    players = sum(1 for row in grid if row[2] == "player")
    print(f"{len(grid)} grid rows ({players} player rows) across {len(seasons)} seasons {seasons[0]}-{seasons[-1]}; "
          f"{len(ledger)} ledger entries; settled weeks: {settled}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
