import { atsOutcome, scoreWeekWithoutProbabilities } from "./scoring.ts";
import type { PlayerCard, ScoringGame } from "./scoring.ts";

type Row = Record<string, unknown>;
export interface AlertGame extends ScoringGame { gameId: string; kickoff: string; clock: string; period: string }
export interface AlertFeed { games: AlertGame[]; cards: PlayerCard[] }
export interface LeadChange { at: string; from: number; rank: number; wins: number; tied: boolean; events: string[] }
export interface AlertObservation {
  at: string;
  games: AlertGame[];
  ranks: Record<string, number>;
  wins: Record<string, number>;
  changes: Record<string, LeadChange>;
  history: { at: string; ranks: Record<string, number> }[];
}

export function alertKickoff(value: unknown, season: number): string {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text))) return new Date(text).toISOString();
  const match = text.match(/^(?:\w{3}\s+)?(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) throw new Error("Invalid kickoff; alerts withheld.");
  const month = Number(match[1]), day = Number(match[2]), hour = Number(match[3]) % 12 + (match[5].toUpperCase() === "PM" ? 12 : 0);
  const local = Date.UTC(season + (month < 3 ? 1 : 0), month - 1, day, hour, Number(match[4]));
  const noon = new Date(local + 5 * 3600000);
  const zone = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(noon).find(part => part.type === "timeZoneName")?.value;
  const offset = Number(zone?.match(/GMT([+-]\d+)/)?.[1]);
  if (!Number.isFinite(offset)) throw new Error("Unknown Eastern offset.");
  return new Date(local - offset * 3600000).toISOString();
}

export function parseAlertFeed(data: Row, season: number, week: number): AlertFeed {
  if (!data.ok || Number(String(data.season).slice(0, 4)) !== season || Number(data.week) !== week || !Array.isArray(data.games) || !data.games.length || !Array.isArray(data.players)) throw new Error("Current picks feed is unavailable or belongs to another week.");
  const games: AlertGame[] = data.games.map((game: Row, index: number) => {
    const state = String(game.state || game.status || game.espnStatus || "").toUpperCase();
    const status = ["FINAL", "COMPLETED", "POST"].includes(state) ? "FINAL" : ["LIVE", "IN_PROGRESS", "IN"].includes(state) ? "LIVE" : ["PREGAME", "SCHEDULED", "PRE", "PRE_GAME"].includes(state) ? "PREGAME" : null;
    if (!status) throw new Error("Unknown game state; alerts withheld.");
    const favorite = String(game.favorite || "").toUpperCase(), underdog = String(game.underdog || "").toUpperCase();
    const homeFavorite = String(game.home || game.homeTeam).toUpperCase() === favorite;
    const score = (value: unknown): number | null => value == null || value === "" ? null : Number(value);
    const favoriteScore = score(game.favoriteScore ?? (data.favoriteScores as unknown[])?.[index] ?? (homeFavorite ? game.homeScore : game.awayScore));
    const underdogScore = score(game.underdogScore ?? (data.underdogScores as unknown[])?.[index] ?? (homeFavorite ? game.awayScore : game.homeScore));
    if (!favorite || !underdog || game.spread === "" || game.spread == null || !Number.isFinite(Number(game.spread)) || (status !== "PREGAME" && (favoriteScore === null || underdogScore === null || !Number.isFinite(favoriteScore) || !Number.isFinite(underdogScore)))) throw new Error("Incomplete game data; alerts withheld.");
    return { gameId: String(game.gameId || game.id || index), favorite, underdog, spread: Number(game.spread), status, favoriteScore, underdogScore, kickoff: alertKickoff(game.kickoff, season), clock: String(game.clock || ""), period: String(game.period || "") };
  });
  const cards: PlayerCard[] = data.players.map((player: Row) => {
    const picks = Array.isArray(player.picks) ? player.picks.map(pick => String(pick).toUpperCase()) : [];
    const bestBet = String(player.bestBet || "").toUpperCase();
    if (!player.name || picks.length !== games.length || picks.some((pick, index) => ![games[index].favorite, games[index].underdog].includes(pick)) || !picks.includes(bestBet) || player.tiebreaker == null || player.tiebreaker === "" || !Number.isFinite(Number(player.tiebreaker))) throw new Error("Incomplete submitted card; alerts withheld.");
    return { name: String(player.name), weekName: String(player.weekName || ""), picks, bestBet, tiebreaker: Number(player.tiebreaker) };
  });
  if (new Set(cards.map(card => card.name.toLowerCase())).size !== cards.length) throw new Error("Duplicate players; alerts withheld.");
  return { games, cards };
}

export function observeLeads(feed: AlertFeed, previous: AlertObservation | null, at: string): AlertObservation {
  const scored = scoreWeekWithoutProbabilities(feed.cards, feed.games, null);
  const ranks = Object.fromEntries(scored.map(player => [player.name, 1 + scored.filter(other => other.wins > player.wins).length]));
  const wins = Object.fromEntries(scored.map(player => [player.name, player.wins]));
  const changes = { ...previous?.changes };
  const started = feed.games.some(game => game.status !== "PREGAME");
  for (const player of scored) {
    if (ranks[player.name] !== 1) { delete changes[player.name]; continue; }
    if (!started || !previous || !(previous.ranks[player.name] > 1)) continue;
    const events = feed.games.flatMap((game, index) => {
      const old = previous.games.find(row => row.gameId === game.gameId);
      if (!old || (old.favoriteScore === game.favoriteScore && old.underdogScore === game.underdogScore && old.status === game.status)) return [];
      const outcome = atsOutcome(game), oldOutcome = old.status === "PREGAME" ? null : atsOutcome(old);
      const winner = outcome === "favorite" ? game.favorite : outcome === "underdog" ? game.underdog : null;
      const oldWinner = oldOutcome === "favorite" ? old.favorite : oldOutcome === "underdog" ? old.underdog : null;
      const units = player.bestBet === player.picks[index] ? 2 : 1;
      const gain = (winner === player.picks[index] ? units : 0) - (oldWinner === player.picks[index] ? units : 0);
      return [`${game.favorite} ${game.favoriteScore} - ${game.underdog} ${game.underdogScore} (${game.status}${game.period ? `, period ${game.period}` : ""}${game.clock ? `, ${game.clock}` : ""}): ${winner ? `${winner} ${game.status === "FINAL" ? "covered" : "is covering"}` : "ATS push"}; your pick ${player.picks[index]}${units === 2 ? " (Best Bet)" : ""}, ${gain > 0 ? "+" : ""}${gain} wins since the prior check.`];
    });
    changes[player.name] = { at, from: previous.ranks[player.name], rank: 1, wins: player.wins, tied: scored.filter(other => other.wins === player.wins).length > 1, events };
  }
  const changed = !previous || JSON.stringify(previous.ranks) !== JSON.stringify(ranks);
  const history = [...(previous?.history || []), ...(changed ? [{ at, ranks }] : [])].slice(-120);
  return { at, games: feed.games, ranks, wins, changes, history };
}

export function tiebreakNeed(player: PlayerCard, opponents: PlayerCard[]): string {
  let lower = -Infinity, upper = Infinity;
  const same = opponents.filter(other => other.tiebreaker === player.tiebreaker);
  for (const opponent of opponents) {
    const midpoint = (player.tiebreaker + opponent.tiebreaker) / 2;
    if (opponent.tiebreaker < player.tiebreaker) lower = Math.max(lower, midpoint);
    if (opponent.tiebreaker > player.tiebreaker) upper = Math.min(upper, midpoint);
  }
  const low = Number.isFinite(lower) ? Math.floor(lower) + 1 : null;
  const high = Number.isFinite(upper) ? Math.ceil(upper) - 1 : null;
  const range = low === null ? high === null ? "any total" : `${high} or fewer yards` : high === null ? `${low} or more yards` : low > high ? "no integer total outright" : `${low}-${high} yards`;
  const boundaries = [lower, upper].filter(Number.isInteger);
  return `you need ${range}${same.length ? ` (same guess as ${same.map(card => card.name).join(", ")}; shared result)` : ""}${boundaries.length ? `; ${boundaries.join(" or ")} yards ties at the boundary` : ""}`;
}

export function nightPaths(feed: AlertFeed, name: string): { eligible: boolean; total: number; count: number; examples: string[] } {
  const playerIndex = feed.cards.findIndex(card => card.name === name);
  const remaining = feed.games.map((game, index) => ({ game, index })).filter(({ game }) => game.status !== "FINAL");
  if (playerIndex < 0) return { eligible: false, total: 0, count: 0, examples: [] };
  if (remaining.length > 8) throw new Error("Too many unresolved games for exact night-game alerts; retry on next check.");
  const base = scoreWeekWithoutProbabilities(feed.cards, feed.games.map(game => game.status === "FINAL" ? game : { ...game, status: "PREGAME" }), null).map(player => player.wins);
  const options = remaining.map(({ game }) => Number.isInteger(game.spread) ? [game.favorite, game.underdog, "push"] : [game.favorite, game.underdog]);
  const total = options.reduce((count, outcomes) => count * outcomes.length, 1);
  let count = 0;
  const examples: string[] = [];
  for (let scenario = 0; scenario < total; scenario++) {
    let cursor = scenario;
    const wins = [...base], descriptions: string[] = [];
    remaining.forEach(({ game, index }, remainingIndex) => {
      const outcomes = options[remainingIndex], winner = outcomes[cursor % outcomes.length];
      cursor = Math.floor(cursor / outcomes.length);
      descriptions.push(winner === "push" ? `${game.favorite}-${game.underdog} pushes` : `${winner} covers`);
      feed.cards.forEach((card, cardIndex) => { if (card.picks[index] === winner) wins[cardIndex] += card.bestBet === winner ? 2 : 1; });
    });
    if (wins[playerIndex] !== Math.max(...wins)) continue;
    const tied = feed.cards.filter((_, index) => index !== playerIndex && wins[index] === wins[playerIndex]);
    const guess = feed.cards[playerIndex].tiebreaker;
    const lower = Math.max(-Infinity, ...tied.filter(card => card.tiebreaker < guess).map(card => (guess + card.tiebreaker) / 2));
    const upper = Math.min(Infinity, ...tied.filter(card => card.tiebreaker > guess).map(card => (guess + card.tiebreaker) / 2));
    if (Math.ceil(lower) > Math.floor(upper)) continue;
    count++;
    if (examples.length < 12) {
      examples.push(`${descriptions.join(" + ") || "All games final"}: ${wins[playerIndex]} wins, ${tied.length ? `tied with ${tied.map(card => `${card.name} (guess ${card.tiebreaker})`).join(", ")}; final-game net passing decides: ${tiebreakNeed(feed.cards[playerIndex], tied)}` : "outright first"}.`);
    }
  }
  return { eligible: count > 0, total, count, examples };
}

const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
export function alertEmailHtml(title: string, body: string, siteUrl: string, stopUrl: string): string {
  const button = (label: string, url: string, background: string, foreground: string) => `<a href="${escape(url)}" style="display:inline-block;padding:13px 20px;margin:4px 8px 4px 0;background:${background};color:${foreground};border-radius:5px;text-decoration:none;font-weight:bold">${label}</a>`;
  return `<div style="max-width:620px;margin:auto;padding:24px;font:16px/1.5 Arial,sans-serif;color:#17212b;background:#ffffff"><h2>${escape(title)}</h2><div style="white-space:pre-line">${escape(body)}</div><p>${button("Open FBP", siteUrl, "#ffcf40", "#17212b")}${button("Stop notifications", stopUrl, "#263746", "#ffffff")}</p></div>`;
}