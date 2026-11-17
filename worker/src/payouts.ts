// Payout grid (formerly the Google Sheet "payout" tab) and its ledger, stored in D1.
// Balances use the Sheet's convention: "100" = player owes $100, "+520" = pool owes the player $520, "even" = 0.
// In cents: positive = player owes, negative = player has a credit.
import { scoreWeekWithoutProbabilities, type PlayerCard, type ScoringGame } from "./scoring";

export const PAYOUT_COLUMNS = 20; // Sheet columns B..U (weeks 1-18, Playoffs, Balance)
export const REGULAR_ENTRY_CENTS = 1000;

export type PayoutRowKind = "title" | "periods" | "fees" | "player" | "champion" | "total" | "note";

export interface PayoutRow {
  season: number;
  position: number;
  kind: PayoutRowKind;
  label: string;
  cells: string[];
}

export interface LedgerInput {
  season: number;
  player: string;
  type: string;
  period?: string;
  moneyInCents?: number;
  moneyOutCents?: number;
  balanceChangeCents?: number;
  balanceAfterCents?: number | null;
  reference: string;
  notes?: string;
  cellOld?: string | null;
  cellNew?: string | null;
  source?: string;
  effectiveAt?: string;
}

export const normalizeName = (value: unknown): string => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();

const padCells = (cells: unknown[]): string[] => {
  const out = cells.slice(0, PAYOUT_COLUMNS).map((cell) => String(cell ?? ""));
  while (out.length < PAYOUT_COLUMNS) out.push("");
  return out;
};

export const balanceCents = (value: unknown): number => {
  const text = String(value ?? "").trim();
  if (!text || text.toLowerCase() === "even") return 0;
  const amount = Number(text.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(amount)) throw new Error(`Unrecognized balance: ${text}`);
  const cents = Math.round(amount * 100);
  return text.startsWith("+") ? -cents : cents;
};

export const dollarsText = (cents: number): string => {
  const value = Math.abs(cents) / 100;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

export const balanceText = (cents: number): string => {
  if (Math.abs(cents) < 1) return "even";
  return cents < 0 ? `+${dollarsText(cents)}` : dollarsText(cents);
};

export const money = (cents: number): string => `$${dollarsText(cents)}`;

/** A cell holding a plain dollar amount ("10", "$20") is money owed for that period; anything else owes nothing. */
export const owedCents = (value: unknown): number => {
  const text = String(value ?? "").trim().replace(/^\$/, "");
  return /^\d+(?:\.\d+)?$/.test(text) ? Math.round(Number(text) * 100) : 0;
};

const isPrepaid = (value: unknown): boolean => /^paid(?:\s+\d+)?$/i.test(String(value ?? "").trim());

const rowFromDb = (row: Record<string, unknown>): PayoutRow => ({
  season: Number(row.season),
  position: Number(row.position),
  kind: String(row.kind) as PayoutRowKind,
  label: String(row.label),
  cells: padCells(JSON.parse(String(row.cells_json || "[]")) as unknown[]),
});

export const loadSeasonRows = async (db: D1Database, season: number): Promise<PayoutRow[]> => {
  const result = await db.prepare("SELECT season, position, kind, label, cells_json FROM payout_rows WHERE season = ? ORDER BY position").bind(season).all();
  return (result.results || []).map(rowFromDb);
};

export const payoutSeasons = async (db: D1Database): Promise<number[]> => {
  const result = await db.prepare("SELECT DISTINCT season FROM payout_rows ORDER BY season DESC").all<{ season: number }>();
  return (result.results || []).map((row) => Number(row.season));
};

/** The whole grid in the Sheet's row layout, newest season first (what the public Payout page parses). */
export const publicSheetRows = async (db: D1Database): Promise<string[][]> => {
  const result = await db.prepare("SELECT season, position, kind, label, cells_json FROM payout_rows ORDER BY season DESC, position").all();
  return (result.results || []).map(rowFromDb).map((row) => [row.label, ...row.cells]);
};

export const periodLabels = (rows: PayoutRow[]): string[] => rows.find((row) => row.kind === "periods")?.cells || [];

export const periodIndex = (rows: PayoutRow[], period: string | number): number => {
  const wanted = String(period).trim().toLowerCase();
  return periodLabels(rows).findIndex((label) => label.trim().toLowerCase() === wanted);
};

export const balanceIndex = (rows: PayoutRow[]): number => {
  const index = periodIndex(rows, "balance");
  return index >= 0 ? index : PAYOUT_COLUMNS - 1;
};

const feeCents = (rows: PayoutRow[], index: number): number => {
  const label = (periodLabels(rows)[index] || "").trim().toLowerCase();
  if (label !== "playoffs") return REGULAR_ENTRY_CENTS;
  return owedCents(rows.find((row) => row.kind === "fees")?.cells[index]) || 2000;
};

const findPlayer = (rows: PayoutRow[], name: string): PayoutRow | undefined =>
  rows.find((row) => row.kind === "player" && normalizeName(row.label) === normalizeName(name));

/** Totals row for the current season: entries x fee for each period, and the sum of those in Balance. */
const recomputeTotals = (rows: PayoutRow[]): PayoutRow | null => {
  const total = rows.find((row) => row.kind === "total");
  if (!total) return null;
  const labels = periodLabels(rows);
  const balance = balanceIndex(rows);
  let sum = 0;
  const cells = [...total.cells];
  labels.forEach((label, index) => {
    if (index === balance || !label.trim()) return;
    // Same as the Sheet's formula: =(COUNTA(week cells) * 10) - champion reserve; Playoffs: COUNTA * playoff fee.
    const entries = rows.filter((row) => row.kind === "player" && row.cells[index].trim()).length;
    const playoffs = label.trim().toLowerCase() === "playoffs";
    const reserve = playoffs ? 0 : owedCents(rows.find((row) => row.kind === "champion")?.cells[index]);
    const value = entries * feeCents(rows, index) - reserve;
    sum += value;
    cells[index] = dollarsText(value);
  });
  cells[balance] = dollarsText(sum);
  if (cells.join("\u0001") === total.cells.join("\u0001")) return null;
  total.cells = cells;
  return total;
};

const rowUpdate = (db: D1Database, row: PayoutRow): D1PreparedStatement =>
  db.prepare("UPDATE payout_rows SET cells_json = ?, label = ?, updated_at = CURRENT_TIMESTAMP WHERE season = ? AND position = ?")
    .bind(JSON.stringify(row.cells), row.label, row.season, row.position);

export const ledgerInsert = (db: D1Database, entry: LedgerInput): D1PreparedStatement =>
  db.prepare(
    `INSERT INTO payout_ledger (effective_at, season, player, type, period, money_in_cents, money_out_cents, balance_change_cents,
       balance_after_cents, reference, notes, cell_old, cell_new, source)
     VALUES (COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (reference) DO NOTHING`,
  ).bind(
    entry.effectiveAt ?? null, entry.season, entry.player, entry.type, entry.period ?? "",
    entry.moneyInCents ?? 0, entry.moneyOutCents ?? 0, entry.balanceChangeCents ?? 0,
    entry.balanceAfterCents ?? null, entry.reference, entry.notes ?? "",
    entry.cellOld ?? null, entry.cellNew ?? null, entry.source ?? "admin",
  );

const periodName = (label: string): string => (label.trim().toLowerCase() === "playoffs" ? "Playoffs" : `Week ${label.trim()}`);
const uniqueReference = (prefix: string): string => `${prefix}|${new Date().toISOString()}|${crypto.randomUUID().slice(0, 8)}`;

export interface CellEditResult {
  player: string;
  period: string;
  oldValue: string;
  newValue: string;
  balanceBefore: string;
  balanceAfter: string;
}

/**
 * Change one cell, like typing in the Sheet. A week cell that changes how much is owed ("10" -> "paid") moves the
 * balance by the same amount unless adjustBalance is false. Typing in the Balance column sets the balance directly.
 */
export const editPayoutCell = async (
  db: D1Database,
  input: { season: number; player: string; column: string; value: string; adjustBalance?: boolean; note?: string },
): Promise<CellEditResult> => {
  const rows = await loadSeasonRows(db, input.season);
  if (!rows.length) throw new Error(`Season ${input.season} is not in the payout grid.`);
  const row = input.player.trim().toLowerCase() === "__champion__"
    ? rows.find((item) => item.kind === "champion")
    : findPlayer(rows, input.player);
  if (!row) throw new Error(`${input.player} is not in the ${input.season} payout grid.`);
  const index = periodIndex(rows, input.column);
  if (index < 0) throw new Error(`Column ${input.column} was not found for ${input.season}.`);
  const value = String(input.value ?? "").trim();
  if (value.length > 40) throw new Error("Keep cell values short (40 characters or fewer).");
  const balanceColumn = balanceIndex(rows);
  const oldValue = row.cells[index];
  if (oldValue === value) {
    return { player: row.label, period: input.column, oldValue, newValue: value, balanceBefore: row.cells[balanceColumn], balanceAfter: row.cells[balanceColumn] };
  }
  const balanceBefore = row.kind === "player" ? balanceCents(row.cells[balanceColumn]) : 0;
  let balanceAfter = balanceBefore;
  let type = "CELL_EDIT";
  if (row.kind === "player" && index === balanceColumn) {
    balanceAfter = balanceCents(value);
    type = "BALANCE_EDIT";
    row.cells[index] = balanceText(balanceAfter);
  } else {
    row.cells[index] = value;
    if (row.kind === "player" && input.adjustBalance !== false) {
      balanceAfter = balanceBefore + owedCents(value) - owedCents(oldValue);
      row.cells[balanceColumn] = balanceText(balanceAfter);
    }
  }
  const statements = [rowUpdate(db, row)];
  if (rows.length && Math.max(...(await payoutSeasons(db))) === input.season) {
    const totals = recomputeTotals(rows);
    if (totals) statements.push(rowUpdate(db, totals));
  }
  const label = periodLabels(rows)[index] || input.column;
  statements.push(ledgerInsert(db, {
    season: input.season,
    player: row.kind === "champion" ? "Season champion" : row.label,
    type,
    period: index === balanceColumn ? "Balance" : label,
    balanceChangeCents: balanceAfter - balanceBefore,
    balanceAfterCents: row.kind === "player" ? balanceAfter : null,
    reference: uniqueReference("EDIT"),
    notes: input.note?.trim() || (index === balanceColumn
      ? `Balance changed from ${balanceText(balanceBefore)} to ${balanceText(balanceAfter)}.`
      : `${periodName(label)} changed from "${oldValue || "blank"}" to "${value || "blank"}".`),
    cellOld: oldValue,
    cellNew: row.cells[index],
  }));
  await db.batch(statements);
  return {
    player: row.label,
    period: label,
    oldValue,
    newValue: row.cells[index],
    balanceBefore: balanceText(balanceBefore),
    balanceAfter: row.kind === "player" ? row.cells[balanceColumn] : "",
  };
};

/**
 * Money received from a player. Owed week cells ("10") become "paid", oldest first, as far as the payment covers;
 * the balance goes down by the full amount (anything extra becomes a credit).
 */
export const recordPayment = async (db: D1Database, input: { season: number; player: string; amountCents: number; note?: string }) => {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new Error("Enter a payment amount above $0.");
  const rows = await loadSeasonRows(db, input.season);
  const row = findPlayer(rows, input.player);
  if (!row) throw new Error(`${input.player} is not in the ${input.season} payout grid.`);
  const balanceColumn = balanceIndex(rows);
  const before = balanceCents(row.cells[balanceColumn]);
  let remaining = input.amountCents;
  const covered: string[] = [];
  periodLabels(rows).forEach((label, index) => {
    if (index === balanceColumn || !label.trim()) return;
    const owed = owedCents(row.cells[index]);
    if (owed && owed <= remaining) {
      row.cells[index] = "paid";
      remaining -= owed;
      covered.push(periodName(label));
    }
  });
  const after = before - input.amountCents;
  row.cells[balanceColumn] = balanceText(after);
  const statements = [rowUpdate(db, row), ledgerInsert(db, {
    season: input.season,
    player: row.label,
    type: "PAYMENT_RECEIVED",
    period: "Manual",
    moneyInCents: input.amountCents,
    balanceChangeCents: -input.amountCents,
    balanceAfterCents: after,
    reference: uniqueReference("PAYMENT"),
    notes: [input.note?.trim(), covered.length ? `Marked paid: ${covered.join(", ")}.` : ""].filter(Boolean).join(" "),
  })];
  await db.batch(statements);
  return { player: row.label, balanceBefore: balanceText(before), balanceAfter: balanceText(after), covered };
};

/** Cash paid out to a player against their credit (a "+" balance). */
export const recordPayout = async (db: D1Database, input: { season: number; player: string; amountCents: number; note?: string }) => {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new Error("Enter a payout amount above $0.");
  const rows = await loadSeasonRows(db, input.season);
  const row = findPlayer(rows, input.player);
  if (!row) throw new Error(`${input.player} is not in the ${input.season} payout grid.`);
  const balanceColumn = balanceIndex(rows);
  const before = balanceCents(row.cells[balanceColumn]);
  const after = before + input.amountCents;
  row.cells[balanceColumn] = balanceText(after);
  await db.batch([rowUpdate(db, row), ledgerInsert(db, {
    season: input.season,
    player: row.label,
    type: "CASH_PAID_OUT",
    period: "Manual",
    moneyOutCents: input.amountCents,
    balanceChangeCents: input.amountCents,
    balanceAfterCents: after,
    reference: uniqueReference("PAYOUT"),
    notes: input.note?.trim() || "",
  })]);
  return { player: row.label, balanceBefore: balanceText(before), balanceAfter: balanceText(after) };
};

/** Insert player rows just above the champion row (or at the end of the season's player rows). */
export const addPayoutPlayers = async (db: D1Database, season: number, names: string[], note = ""): Promise<string[]> => {
  const rows = await loadSeasonRows(db, season);
  if (!rows.length) throw new Error(`Season ${season} is not in the payout grid.`);
  const wanted = [...new Map(names.map((name) => [normalizeName(name), name.trim().replace(/\s+/g, " ")])).values()]
    .filter((name) => name && !findPlayer(rows, name));
  if (!wanted.length) return [];
  const anchor = rows.find((row) => row.kind === "champion" || row.kind === "total");
  const insertAt = anchor ? anchor.position : Math.max(...rows.map((row) => row.position)) + 1;
  const shift = wanted.length;
  const balanceColumn = balanceIndex(rows);
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE payout_rows SET position = position + 100000 WHERE season = ? AND position >= ?").bind(season, insertAt),
    db.prepare("UPDATE payout_rows SET position = position - 100000 + ? WHERE season = ? AND position >= 100000").bind(shift, season),
  ];
  wanted.forEach((name, offset) => {
    const cells = padCells([]);
    cells[balanceColumn] = "even";
    statements.push(db.prepare("INSERT INTO payout_rows (season, position, kind, label, cells_json) VALUES (?, ?, 'player', ?, ?)")
      .bind(season, insertAt + offset, name, JSON.stringify(cells)));
    statements.push(ledgerInsert(db, {
      season,
      player: name,
      type: "PLAYER_ADDED",
      balanceAfterCents: 0,
      reference: `PLAYER|${season}|${normalizeName(name)}`,
      notes: note || "Added to the payout grid.",
    }));
  });
  await db.batch(statements);
  return wanted;
};

export const ledgerEntries = async (db: D1Database, season: number, player = "", limit = 200) => {
  const query = player
    ? db.prepare("SELECT * FROM payout_ledger WHERE season = ? AND player = ? COLLATE NOCASE ORDER BY id DESC LIMIT ?").bind(season, player, limit)
    : db.prepare("SELECT * FROM payout_ledger WHERE season = ? ORDER BY id DESC LIMIT ?").bind(season, limit);
  return (await query.all()).results || [];
};

// ---------------------------------------------------------------------------------------------------------------
// Weekly settlement (replaces the Apps Script "sync-finalized-payouts" job that edited the Sheet).

export interface ArchiveSubmission {
  name: string;
  weekName?: string;
  picks: string[];
  bestBet: string;
  tiebreaker: number;
}

export interface WeekArchive {
  seasonStart: number;
  week: number;
  actualTiebreaker: number;
  games: Array<Record<string, unknown>>;
  submissions: ArchiveSubmission[];
}

export interface RankedPlayer {
  name: string;
  weekName: string;
  wins: number;
  losses: number;
  tiebreaker: number;
  tiebreakDifference: number;
}

export const rankArchive = (archive: WeekArchive): RankedPlayer[] => {
  const games: ScoringGame[] = archive.games.map((game) => ({
    favorite: String(game.favorite || ""),
    underdog: String(game.underdog || ""),
    spread: Number(game.spread),
    status: (String(game.state || game.status || "FINAL").toUpperCase() as ScoringGame["status"]),
    favoriteScore: game.favoriteScore == null ? null : Number(game.favoriteScore),
    underdogScore: game.underdogScore == null ? null : Number(game.underdogScore),
  }));
  const cards: PlayerCard[] = archive.submissions.map((submission) => ({
    name: String(submission.name || "").trim(),
    weekName: String(submission.weekName || ""),
    picks: submission.picks.map(String),
    bestBet: String(submission.bestBet || ""),
    tiebreaker: Number(submission.tiebreaker),
  })).filter((card) => card.name);
  return scoreWeekWithoutProbabilities(cards, games, Number(archive.actualTiebreaker)).map((player) => ({
    name: player.name,
    weekName: player.weekName,
    wins: player.wins,
    losses: player.losses,
    tiebreaker: player.tiebreaker,
    tiebreakDifference: player.tiebreakDifference ?? Number.POSITIVE_INFINITY,
  })).sort((left, right) => right.wins - left.wins || left.tiebreakDifference - right.tiebreakDifference || left.name.localeCompare(right.name));
};

export const archiveWinners = (ranked: RankedPlayer[]): RankedPlayer[] => {
  const leader = ranked[0];
  if (!leader || !Number.isFinite(leader.tiebreakDifference)) throw new Error("The finalized week has no valid winner.");
  return ranked.filter((player) => player.wins === leader.wins && player.tiebreakDifference === leader.tiebreakDifference);
};

export interface WinnerBreakdown {
  name: string;
  balanceBeforePrizeCents: number;
  balanceAfterCents: number;
  paidForSeason: boolean;
  weekStatus: string;
}

export interface SettlementReport {
  season: number;
  week: number;
  entries: number;
  entryCents: number;
  reserveCents: number;
  prizeCents: number;
  shareCents: number;
  winners: RankedPlayer[];
  ranked: RankedPlayer[];
  breakdown: WinnerBreakdown[];
  changes: string[];
  addedPlayers: string[];
  alreadySettled: boolean;
}

/** Charge entries, roll over or credit unused prepaid weeks, and credit the winner(s) — once per finalized week. */
export const settleFinalizedWeek = async (db: D1Database, archive: WeekArchive): Promise<SettlementReport> => {
  const season = Number(archive.seasonStart);
  const week = Number(archive.week);
  const participants = archive.submissions.map((submission) => String(submission.name || "").trim()).filter(Boolean);
  if (!participants.length) throw new Error(`Week ${week} has no finalized participants.`);
  const ranked = rankArchive(archive);
  const winners = archiveWinners(ranked);
  const existing = await db.prepare("SELECT reference FROM payout_ledger WHERE season = ? AND reference LIKE ?").bind(season, `%|${season}|${week}|%`).all<{ reference: string }>();
  const references = new Set((existing.results || []).map((row) => row.reference));
  const addedPlayers = await addPayoutPlayers(db, season, participants, `Played Week ${week}; added automatically.`);
  const rows = await loadSeasonRows(db, season);
  const index = periodIndex(rows, String(week));
  if (index < 0) throw new Error(`Week ${week} is not a column in the ${season} payout grid.`);
  const balanceColumn = balanceIndex(rows);
  const fee = feeCents(rows, index);
  const label = periodLabels(rows)[index];
  const played = new Set(participants.map(normalizeName));
  const ledger: LedgerInput[] = [];
  const changed = new Set<PayoutRow>();
  const changes: string[] = [];
  const seasonLabel = String(season);
  for (const row of rows.filter((item) => item.kind === "player")) {
    const key = normalizeName(row.label);
    const status = row.cells[index].trim();
    if (played.has(key) && !status) {
      const reference = `AUTO|${seasonLabel}|${week}|${key}|CHARGE`;
      if (references.has(reference)) continue;
      const after = balanceCents(row.cells[balanceColumn]) + fee;
      row.cells[index] = dollarsText(fee);
      row.cells[balanceColumn] = balanceText(after);
      changed.add(row);
      changes.push(`${row.label}: played Week ${week} on credit (+${money(fee)}).`);
      ledger.push({ season, player: row.label, type: "WEEKLY_CHARGE", period: label, balanceChangeCents: fee, balanceAfterCents: after, reference, notes: `Played Week ${week} on credit.`, source: "automatic" });
      continue;
    }
    if (played.has(key) || !isPrepaid(status)) continue;
    const labels = periodLabels(rows);
    let rollover = -1;
    for (let column = index + 1; column < balanceColumn; column += 1) {
      if (labels[column]?.trim() && !row.cells[column].trim()) { rollover = column; break; }
    }
    if (rollover >= 0) {
      const reference = `AUTO|${seasonLabel}|${week}|${key}|ROLLOVER`;
      if (references.has(reference)) continue;
      row.cells[index] = "";
      row.cells[rollover] = status;
      changed.add(row);
      changes.push(`${row.label}: prepaid Week ${week} moved to ${periodName(labels[rollover])}.`);
      ledger.push({ season, player: row.label, type: "PREPAID_ROLLOVER", period: label, balanceAfterCents: balanceCents(row.cells[balanceColumn]), reference, notes: `Unused prepaid Week ${week} entry moved to ${periodName(labels[rollover])}.`, source: "automatic" });
    } else {
      const reference = `AUTO|${seasonLabel}|${week}|${key}|UNUSED_CREDIT`;
      if (references.has(reference)) continue;
      const after = balanceCents(row.cells[balanceColumn]) - fee;
      row.cells[index] = "";
      row.cells[balanceColumn] = balanceText(after);
      changed.add(row);
      changes.push(`${row.label}: unused prepaid Week ${week} added to credit.`);
      ledger.push({ season, player: row.label, type: "UNUSED_PREPAID_CREDIT", period: label, balanceChangeCents: -fee, balanceAfterCents: after, reference, notes: `Unused prepaid Week ${week} entry added to player credit.`, source: "automatic" });
    }
  }
  const champion = rows.find((row) => row.kind === "champion");
  const reserve = owedCents(champion?.cells[index]);
  const entryCents = participants.length * fee;
  const prize = Math.max(0, entryCents - reserve);
  const share = Math.round(prize / winners.length);
  const breakdown: WinnerBreakdown[] = [];
  let alreadySettled = true;
  for (const winner of winners) {
    const row = findPlayer(rows, winner.name);
    if (!row) throw new Error(`Payout row is missing for winner ${winner.name}.`);
    const reference = `PRIZE|${seasonLabel}|${week}|${row.label}`;
    const before = balanceCents(row.cells[balanceColumn]);
    const regular = periodLabels(rows).map((value, column) => ({ value, column })).filter(({ value, column }) => column < balanceColumn && /^\d+$/.test(value.trim()));
    const paidForSeason = before === 0 && regular.length === 18 && regular.every(({ column }) => /^(paid|win|tie)/i.test(row.cells[column].trim()));
    if (references.has(reference)) {
      breakdown.push({ name: row.label, balanceBeforePrizeCents: before + share, balanceAfterCents: before, paidForSeason, weekStatus: row.cells[index] });
      continue;
    }
    alreadySettled = false;
    const after = before - share;
    breakdown.push({ name: row.label, balanceBeforePrizeCents: before, balanceAfterCents: after, paidForSeason, weekStatus: row.cells[index] });
    row.cells[index] = "win";
    row.cells[balanceColumn] = balanceText(after);
    changed.add(row);
    changes.push(`${row.label}: won Week ${week} (${money(share)} credit).`);
    ledger.push({ season, player: row.label, type: "PRIZE_CREDIT", period: label, balanceChangeCents: -share, balanceAfterCents: after, reference, notes: `Week ${week} winner credit: ${money(share)} of the ${money(prize)} net prize.`, source: "automatic" });
  }
  if (ledger.length) alreadySettled = false;
  const statements = [...changed].map((row) => rowUpdate(db, row));
  const totals = recomputeTotals(rows);
  if (totals && statements.length) statements.push(rowUpdate(db, totals));
  ledger.forEach((entry) => statements.push(ledgerInsert(db, entry)));
  statements.push(db.prepare("INSERT INTO payout_settlements (season, week) VALUES (?, ?) ON CONFLICT (season, week) DO NOTHING").bind(season, week));
  await db.batch(statements);
  return { season, week, entries: participants.length, entryCents, reserveCents: reserve, prizeCents: prize, shareCents: share, winners, ranked, breakdown, changes, addedPlayers, alreadySettled };
};

// ---------------------------------------------------------------------------------------------------------------
// Owner winner email (replaces the Apps Script winner email).

const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (character) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
)[character]);

export const winnerBreakdownLine = (item: WinnerBreakdown, shareCents: number, week: number): string => {
  const before = item.balanceBeforePrizeCents;
  if (item.paidForSeason) return `${item.name}: paid up for the year already. ${money(shareCents)} goes to you.`;
  if (before === 0) return `${item.name}: even${/^paid/i.test(item.weekStatus) ? ` (fully prepaid for Week ${week})` : ""}. Pay ${money(shareCents)} now and leave the balance even, or carry it as a +${money(shareCents)} credit.`;
  if (before > 0) {
    const applied = Math.min(before, shareCents);
    const cash = shareCents - applied;
    const remaining = before - applied;
    return `${item.name}: ${money(before)} owed after the Week ${week} entry. Apply ${money(applied)} of the prize to the balance${cash ? ` and pay ${money(cash)} now` : ""}; ${remaining ? `${money(remaining)} remains owed.` : "the balance is now even."}`;
  }
  return `${item.name}: +${money(-before)} credit before this prize. Pay ${money(shareCents)} now and keep that credit, or carry the prize for a new +${money(-before + shareCents)} credit.`;
};

export const buildWinnerEmail = (report: SettlementReport, siteUrl: string, actualTiebreaker: number) => {
  const names = report.winners.map((winner) => winner.name);
  const label = names.length > 1 ? names.join(" and ") : names[0];
  const leader = report.winners[0];
  const record = `${leader.wins}-${leader.losses}`;
  const weekName = names.length === 1 ? leader.weekName.trim() : "";
  const recapUrl = `${siteUrl.replace(/\/?$/, "/")}winner.html?season=${report.season}&week=${report.week}`;
  const tiedOnWins = report.ranked.filter((player) => player.wins === leader.wins);
  const runnerUp = tiedOnWins.find((player) => player.tiebreakDifference > leader.tiebreakDifference);
  const tiebreakLine = tiedOnWins.length > 1
    ? `${tiedOnWins.length} players finished at ${leader.wins} wins. Actual tiebreaker total: ${actualTiebreaker}. ${label}'s guess of ${leader.tiebreaker} was ${leader.tiebreakDifference} away${runnerUp ? `, ${runnerUp.tiebreakDifference - leader.tiebreakDifference} closer than ${runnerUp.name}` : ""}.`
    : `Actual tiebreaker total: ${actualTiebreaker}. ${label}'s guess: ${leader.tiebreaker}.`;
  const payout = [
    "Payout details:",
    `${report.entries} entries x ${money(report.entryCents / report.entries)} = ${money(report.entryCents)}`,
    `Season champion reserve: -${money(report.reserveCents)}`,
    `Week ${report.week} winnings: ${money(report.prizeCents)}`,
    ...(names.length > 1 ? [`${names.length}-way split: ${money(report.shareCents)} per winner`] : []),
    "",
    "Breakdown:",
    ...report.breakdown.map((item) => winnerBreakdownLine(item, report.shareCents, report.week)),
  ];
  const greeting = names.length > 1 ? `Congratulations!!!\nYou shared Week ${report.week}.` : `Congratulations!!!\nYou won Week ${report.week}.`;
  const share = [greeting, ...(weekName ? ["", `Week name: ${weekName}`] : []), "", `Your Week ${report.week} winner page:`, recapUrl, "", ...payout, "", "Congrats again", "Good luck the rest of the way", "Jim"].join("\n");
  const top = report.ranked.slice(0, 5).map((player, position) => `${position + 1}. ${player.name} ${player.wins}-${player.losses} (tiebreak ${player.tiebreaker}, off by ${player.tiebreakDifference})`);
  const body = [
    `${label} won Week ${report.week} at ${record}.`,
    ...(weekName ? [`Week name: ${weekName}`] : []),
    "",
    tiebreakLine,
    "",
    "Top 5:",
    ...top,
    "",
    "----- Copy and text this to the winner -----",
    share,
  ].join("\n");
  const section = (title: string, inner: string) => `<h2 style="margin:16px 0 7px;padding-top:13px;border-top:1px solid #d9dee5;font-size:14px">${escapeHtml(title)}</h2>${inner}`;
  const htmlBody = `<div style="max-width:650px;margin:0 auto;padding:12px;background:#f4f6f8;font-family:Arial,sans-serif;color:#15202b">
<div style="background:#fff;border:1px solid #d9dee5;border-radius:10px;padding:16px">
<p style="margin:0 0 4px;color:#1d6f80;font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase">FBP Week ${report.week} winner</p>
<h1 style="margin:0 0 6px;font-size:22px">${escapeHtml(label)} &middot; ${escapeHtml(record)}</h1>
${weekName ? `<p style="margin:0 0 10px;color:#4c5966">Week name: ${escapeHtml(weekName)}</p>` : ""}
<p style="margin:0 0 10px;line-height:1.45">${escapeHtml(tiebreakLine)}</p>
${section("Top 5", `<ol style="margin:0;padding-left:20px;line-height:1.5">${report.ranked.slice(0, 5).map((player) => `<li>${escapeHtml(`${player.name} ${player.wins}-${player.losses}`)} <span style="color:#4c5966">(tiebreak ${escapeHtml(player.tiebreaker)}, off by ${escapeHtml(player.tiebreakDifference)})</span></li>`).join("")}</ol>`)}
${section("Payout", `<p style="margin:0;line-height:1.5;white-space:pre-wrap">${escapeHtml(payout.join("\n"))}</p>`)}
<div style="margin:16px 0 0;padding:13px;border:2px dashed #1d6f80;border-radius:8px;background:#f7fbfc">
<h2 style="margin:0 0 4px;font-size:14px;color:#1d6f80">Send this to ${escapeHtml(label)}</h2>
<p style="margin:0 0 10px;text-align:center"><a href="${escapeHtml(recapUrl)}" style="display:inline-block;padding:11px 18px;border-radius:6px;background:#1d6f80;color:#fff;text-decoration:none;font-weight:bold">Open the winner page</a></p>
<div style="padding:11px;border-radius:6px;background:#fff;border:1px solid #d9dee5;white-space:pre-wrap;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:1.5">${escapeHtml(share)}</div>
</div></div></div>`;
  return { subject: `FBP Week ${report.week} winner: ${label}`, body, htmlBody };
};
