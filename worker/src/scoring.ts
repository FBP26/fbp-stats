export type GameStatus = "PREGAME" | "LIVE" | "FINAL";
export type AtsOutcome = "favorite" | "underdog" | "push";

export interface ScoringGame {
  favorite: string;
  underdog: string;
  spread: number;
  status: GameStatus;
  favoriteScore: number | null;
  underdogScore: number | null;
}

export interface PlayerCard {
  name: string;
  weekName: string;
  picks: string[];
  bestBet: string;
  tiebreaker: number;
}

export interface ScoredPlayer extends PlayerCard {
  wins: number;
  losses: number;
  total: number;
  winPercent: number | null;
  tiebreakDifference: number | null;
  winProbability: number;
  pathsToVictory: number;
}

export const atsOutcome = (game: ScoringGame): AtsOutcome | null => {
  if (game.favoriteScore === null || game.underdogScore === null) return null;
  const margin = game.favoriteScore - game.underdogScore - game.spread;
  if (margin === 0) return "push";
  return margin > 0 ? "favorite" : "underdog";
};

const winningTeam = (game: ScoringGame, outcome: AtsOutcome): string | null => {
  if (outcome === "push") return null;
  return outcome === "favorite" ? game.favorite : game.underdog;
};

const scoreDecisions = (
  player: PlayerCard,
  games: ScoringGame[],
  includeGame: (game: ScoringGame) => boolean,
): { wins: number; losses: number } => {
  let wins = 0;
  let losses = 0;
  games.forEach((game, index) => {
    if (!includeGame(game)) return;
    const outcome = atsOutcome(game);
    if (!outcome || outcome === "push") return;
    const winner = winningTeam(game, outcome);
    const units = player.bestBet === player.picks[index] ? 2 : 1;
    if (player.picks[index] === winner) wins += units;
    else losses += units;
  });
  return { wins, losses };
};

const possibleOutcomes = (game: ScoringGame): AtsOutcome[] =>
  Number.isInteger(game.spread)
    ? ["underdog", "favorite", "push"]
    : ["underdog", "favorite"];

const greatestCommonDivisor = (left: number, right: number): number =>
  right ? greatestCommonDivisor(right, left % right) : left;

const scenarioIndexes = (total: number): number[] => {
  if (total <= 250_000) return Array.from({ length: total }, (_, index) => index);
  const count = Math.min(total, 4_096);
  let step = Math.max(1, Math.floor(total * 0.618033988749895));
  while (greatestCommonDivisor(step, total) !== 1) step += 1;
  const offset = Math.floor(total * 0.381966011250105);
  return Array.from({ length: count }, (_, index) => (offset + index * step) % total);
};

export const calculatePaths = (
  players: PlayerCard[],
  games: ScoringGame[],
): { probabilities: number[]; paths: number[]; outcomeCount: number; evaluatedCount: number } => {
  if (!players.length) return { probabilities: [], paths: [], outcomeCount: 0, evaluatedCount: 0 };
  const unresolved = games
    .map((game, index) => ({ game, index, outcomes: possibleOutcomes(game) }))
    .filter(({ game }) => game.status !== "FINAL");
  const outcomeCount = unresolved.reduce((total, item) => total * item.outcomes.length, 1);
  const indexes = scenarioIndexes(outcomeCount);

  const finalWins = players.map((player) => scoreDecisions(player, games, (game) => game.status === "FINAL").wins);
  const paths = players.map(() => 0);

  indexes.forEach((pathIndex) => {
    let pathValue = pathIndex;
    const projectedWins = finalWins.slice();
    unresolved.forEach(({ game, index, outcomes }) => {
      const outcome = outcomes[pathValue % outcomes.length];
      pathValue = Math.floor(pathValue / outcomes.length);
      const winner = winningTeam(game, outcome);
      if (!winner) return;
      players.forEach((player, playerIndex) => {
        if (player.picks[index] !== winner) return;
        projectedWins[playerIndex] += player.bestBet === player.picks[index] ? 2 : 1;
      });
    });
    const leadingScore = Math.max(...projectedWins);
    const leaders = projectedWins
      .map((score, index) => (score === leadingScore ? index : -1))
      .filter((index) => index >= 0);
    const share = 1 / leaders.length;
    leaders.forEach((index) => { paths[index] += share; });
  });

  return {
    probabilities: paths.map((pathCount) => (pathCount / indexes.length) * 100),
    paths,
    outcomeCount,
    evaluatedCount: indexes.length,
  };
};

export const scoreWeekWithoutProbabilities = (
  players: PlayerCard[],
  games: ScoringGame[],
  actualTiebreaker: number | null,
): ScoredPlayer[] => {
  return players.map((player) => {
    const decisions = scoreDecisions(player, games, (game) => game.status !== "PREGAME");
    const decisionCount = decisions.wins + decisions.losses;
    return {
      ...player,
      ...decisions,
      total: decisions.wins,
      winPercent: decisionCount ? (decisions.wins / decisionCount) * 100 : null,
      tiebreakDifference: actualTiebreaker === null ? null : Math.abs(player.tiebreaker - actualTiebreaker),
      winProbability: 0,
      pathsToVictory: 0,
    };
  });
};

export const scoreWeek = (
  players: PlayerCard[],
  games: ScoringGame[],
  actualTiebreaker: number | null,
): ScoredPlayer[] => {
  const probability = calculatePaths(players, games);
  return scoreWeekWithoutProbabilities(players, games, actualTiebreaker).map((player, index) => ({
    ...player,
    winProbability: probability.probabilities[index],
    pathsToVictory: probability.paths[index],
  }));
};

export const compareStandings = (left: ScoredPlayer, right: ScoredPlayer): number =>
  right.total - left.total
  || (left.tiebreakDifference ?? Number.POSITIVE_INFINITY) - (right.tiebreakDifference ?? Number.POSITIVE_INFINITY)
  || left.losses - right.losses
  || left.name.localeCompare(right.name);
