// FBP playoffs: four rounds stored as weeks with phase 'PLAYOFFS' (week = round 1-4).
// Round 1: 6 games + Best Bet = 7 possible wins; Round 2: 4 + BB = 5; Round 3: 2 + BB = 3; Super Bowl: 1 game,
// and the Best Bet must be that game, so 2 possible wins. 17 possible wins in all. The Super Bowl's combined net
// passing yards break a tie. Anyone may play any round; the $20 playoff entry is charged once.

import { atsOutcome, type PlayerCard, type ScoringGame } from "./scoring";

export interface PlayoffRound { round: number; label: string; shortLabel: string; espnWeek: number; games: number; possibleWins: number }

export const PLAYOFF_ROUNDS: PlayoffRound[] = [
  { round: 1, label: "Playoffs Round 1", shortLabel: "Round 1", espnWeek: 1, games: 6, possibleWins: 7 },
  { round: 2, label: "Playoffs Round 2", shortLabel: "Round 2", espnWeek: 2, games: 4, possibleWins: 5 },
  { round: 3, label: "Playoffs Round 3", shortLabel: "Round 3", espnWeek: 3, games: 2, possibleWins: 3 },
  { round: 4, label: "Super Bowl", shortLabel: "Super Bowl", espnWeek: 5, games: 1, possibleWins: 2 },
];

export const playoffRound = (round: number): PlayoffRound => {
  const found = PLAYOFF_ROUNDS.find((item) => item.round === Number(round));
  if (!found) throw new Error(`Unknown playoff round ${round}.`);
  return found;
};

/** "Week 11" for the regular season, "Round 2" / "Super Bowl" for the playoffs. */
export const periodLabel = (phase: unknown, week: unknown): string =>
  String(phase) === "PLAYOFFS" ? playoffRound(Number(week)).shortLabel : `Week ${Number(week)}`;

export interface PlayoffRoundInput {
  round: number;
  games: ScoringGame[];
  cards: PlayerCard[];
  /** False while a round's picks are still hidden; hidden picks never count toward anything shown. */
  revealed: boolean;
  actualTiebreaker?: number | null;
}

export interface PlayoffStanding {
  name: string;
  wins: number;
  losses: number;
  rounds: Record<number, { wins: number; losses: number; played: boolean }>;
  /** Wins still available: undecided games in revealed rounds, plus every round not yet picked or revealed. */
  remaining: number;
  maxWins: number;
  alive: boolean;
  tiebreaker: number | null;
  tiebreakDifference: number | null;
}

const decided = (game: ScoringGame) => game.status === "FINAL" && atsOutcome(game) !== null;

/** Cumulative playoff standings. Players who never played a round can still join a later one. */
export const playoffStandings = (rounds: PlayoffRoundInput[], extraNames: string[] = []): PlayoffStanding[] => {
  const byName = new Map<string, PlayoffStanding>();
  const key = (name: string) => name.trim().toLowerCase();
  const ensure = (name: string) => {
    const existing = byName.get(key(name));
    if (existing) return existing;
    const created: PlayoffStanding = { name: name.trim(), wins: 0, losses: 0, rounds: {}, remaining: 0, maxWins: 0, alive: true, tiebreaker: null, tiebreakDifference: null };
    byName.set(key(name), created);
    return created;
  };
  extraNames.forEach(ensure);
  rounds.forEach((round) => round.cards.forEach((card) => ensure(card.name)));
  const roundsByNumber = new Map(rounds.map((round) => [round.round, round]));
  for (const player of byName.values()) {
    for (const info of PLAYOFF_ROUNDS) {
      const round = roundsByNumber.get(info.round);
      const card = round?.cards.find((item) => key(item.name) === key(player.name));
      if (!round || !round.revealed || !card) {
        // Not picked yet (or hidden): every win in the round is still possible, unless the round is over.
        const over = round && round.games.length > 0 && round.games.every(decided) && round.revealed;
        if (!over) player.remaining += info.possibleWins;
        player.rounds[info.round] = { wins: 0, losses: 0, played: Boolean(card) };
        continue;
      }
      let wins = 0, losses = 0;
      round.games.forEach((game, index) => {
        const units = card.bestBet && card.bestBet === card.picks[index] ? 2 : 1;
        if (!decided(game)) { player.remaining += units; return; }
        const outcome = atsOutcome(game);
        if (outcome === "push") return;
        const winner = outcome === "favorite" ? game.favorite : game.underdog;
        if (card.picks[index] === winner) wins += units; else losses += units;
      });
      player.rounds[info.round] = { wins, losses, played: true };
      player.wins += wins;
      player.losses += losses;
      if (info.round === 4) {
        player.tiebreaker = Number.isFinite(card.tiebreaker) ? card.tiebreaker : null;
        const actual = round.actualTiebreaker;
        if (actual !== null && actual !== undefined && player.tiebreaker !== null) player.tiebreakDifference = Math.abs(player.tiebreaker - actual);
      }
    }
    player.maxWins = player.wins + player.remaining;
  }
  const players = [...byName.values()];
  const leader = Math.max(0, ...players.map((player) => player.wins));
  players.forEach((player) => { player.alive = player.maxWins >= leader; });
  return players.sort((a, b) => b.wins - a.wins
    || (a.tiebreakDifference ?? Number.POSITIVE_INFINITY) - (b.tiebreakDifference ?? Number.POSITIVE_INFINITY)
    || b.maxWins - a.maxWins || a.name.localeCompare(b.name));
};

/** Playoff winners once the Super Bowl is final: most wins, then closest Super Bowl tiebreaker; still tied = split. */
export const playoffWinners = (standings: PlayoffStanding[]): PlayoffStanding[] => {
  const top = standings[0];
  if (!top) return [];
  return standings.filter((player) => player.wins === top.wins && (player.tiebreakDifference ?? Infinity) === (top.tiebreakDifference ?? Infinity));
};
