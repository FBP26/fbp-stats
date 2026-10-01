type ArchiveGame = {
  gameIndex?: number;
  gameId: string;
  kickoff?: string | null;
  gameDate?: string;
  favorite: string;
  underdog: string;
  spread: number;
  homeTeam?: string;
  awayTeam?: string;
  home?: string;
  away?: string;
  state?: string;
  status?: string;
  favoriteScore: number | null;
  underdogScore: number | null;
};

type ArchiveSubmission = { name: string; picks: string[]; bestBet: string; tiebreaker: number | null };
type ArchiveWeek = { season: string; week: number; phase: string; actualTiebreaker: number | null; games: ArchiveGame[]; submissions: ArchiveSubmission[] };

const playerId = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const upper = (value: string) => value.trim().toUpperCase();
const gameDate = (value: unknown) => {
  const text = String(value ?? '').trim();
  const mdy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  if (/^\d{4}-\d\d-\d\d/.test(text)) return text.slice(0, 10);
  throw new Error('Completed history requires a valid game date.');
};

export function adaptCompletedArchive(archive: ArchiveWeek) {
  if (archive.phase !== 'REGULAR_SEASON' || !Array.isArray(archive.games) || !Array.isArray(archive.submissions)) throw new Error('Completed history requires a regular-season archive.');
  const games = archive.games.map((game, index) => ({ ...game, gameIndex: game.gameIndex ?? index, state: game.state ?? game.status,
    homeTeam: game.homeTeam ?? game.home, awayTeam: game.awayTeam ?? game.away })).sort((left, right) => Number(left.gameIndex) - Number(right.gameIndex));
  if (!games.length || games.some((game, index) => Number(game.gameIndex) !== index || String(game.state).toUpperCase() !== 'FINAL' || !game.homeTeam || !game.awayTeam
    || !Number.isFinite(Number(game.favoriteScore)) || !Number.isFinite(Number(game.underdogScore)) || !Number.isFinite(Number(game.spread)))) {
    throw new Error('Completed history requires ordered final games with scores and spreads.');
  }
  const normalizedGames = games.map((game) => {
    const favoriteScore = Number(game.favoriteScore), underdogScore = Number(game.underdogScore), spread = Number(game.spread), homeTeam = String(game.homeTeam), awayTeam = String(game.awayTeam);
    const difference = favoriteScore - underdogScore - spread;
    return {
      gameId: `${archive.season}|${archive.week}|${Number(game.gameIndex) + 1}`,
      season: archive.season, week: String(archive.week), weekOrder: archive.week, gameNum: Number(game.gameIndex) + 1,
      gameDate: gameDate(game.gameDate || game.kickoff), favorite: game.favorite, spread, underdog: game.underdog,
      home: homeTeam, away: awayTeam, homeScore: upper(homeTeam) === upper(game.favorite) ? favoriteScore : underdogScore,
      awayScore: upper(awayTeam) === upper(game.favorite) ? favoriteScore : underdogScore,
      atsResult: difference === 0 ? 'push' : `${difference > 0 ? game.favorite : game.underdog} covered`, gameStatus: 'final', scoringDisposition: 'graded',
    };
  });
  const picks = archive.submissions.flatMap((submission) => {
    if (!Array.isArray(submission.picks) || submission.picks.length !== normalizedGames.length) throw new Error(`${submission.name} does not have one pick per final game.`);
    return normalizedGames.map((game, index) => {
      const pick = String(submission.picks[index]), favorite = upper(game.favorite), underdog = upper(game.underdog), selected = upper(pick);
      if (selected !== favorite && selected !== underdog) throw new Error(`${submission.name} has an invalid archived pick.`);
      const favoriteCovered = game.atsResult === `${game.favorite} covered`, underdogCovered = game.atsResult === `${game.underdog} covered`;
      const result = game.atsResult === 'push' ? 'push' : (selected === favorite) === favoriteCovered && (selected === underdog) === underdogCovered ? 'win' : 'loss';
      const isBestBet = selected === upper(submission.bestBet);
      return {
        gameId: game.gameId, playerId: playerId(submission.name), name: submission.name, pick, bestBet: submission.bestBet,
        homeScore: game.homeScore, awayScore: game.awayScore, result, resultWin: result === 'win' ? 1 : 0, resultLoss: result === 'loss' ? 1 : 0, resultPush: result === 'push' ? 1 : 0,
        bestBetResult: isBestBet ? result : null, bestBetWin: isBestBet && result === 'win' ? 1 : 0, bestBetLoss: isBestBet && result === 'loss' ? 1 : 0, bestBetPush: isBestBet && result === 'push' ? 1 : 0,
        tiebreaker: submission.tiebreaker, actualTiebreak: archive.actualTiebreaker,
      };
    });
  });
  return { games: normalizedGames, picks };
}