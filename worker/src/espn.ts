export interface StoredGame {
  id: number;
  externalId: string;
  favorite: string;
  underdog: string;
  homeTeam: string;
  awayTeam: string;
  metadata: Record<string, unknown>;
}

export interface EspnGameUpdate {
  state: "PREGAME" | "LIVE" | "FINAL";
  status: "PREGAME" | "IN_PROGRESS" | "FINAL";
  statusText: string;
  favoriteScore: number | null;
  underdogScore: number | null;
  homeScore: number | null;
  awayScore: number | null;
  period: string;
  clock: string;
  possession: string;
  combinedNetPassingYards: number | null;
}

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const normalizedTeam = (value: unknown): string => {
  const abbreviation = String(value || "").trim().toUpperCase();
  return ({ JAC: "JAX", LA: "LAR", WSH: "WAS" } as Record<string, string>)[abbreviation] || abbreviation;
};

const optionalNumber = (value: unknown): number | null => {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const teamStatistic = (team: JsonRecord, name: string): number | null => {
  const statistic = array(team.statistics).map(record).find((item) => item.name === name);
  return optionalNumber(statistic?.value ?? statistic?.displayValue);
};

export const parseEspnGame = (payload: unknown, game: StoredGame): EspnGameUpdate => {
  const packageJson = record(record(payload).gamepackageJSON);
  const competition = record(array(record(packageJson.header).competitions)[0]);
  const status = record(competition.status);
  const statusType = record(status.type);
  const stateValue = String(statusType.state || "pre").toLowerCase();
  const state = stateValue === "post" || statusType.completed === true
    ? "FINAL"
    : stateValue === "in" ? "LIVE" : "PREGAME";
  const competitors = array(competition.competitors).map(record);
  const home = competitors.find((team) => team.homeAway === "home") || {};
  const away = competitors.find((team) => team.homeAway === "away") || {};
  const homeAbbreviation = normalizedTeam(record(home.team).abbreviation);
  const awayAbbreviation = normalizedTeam(record(away.team).abbreviation);
  if (homeAbbreviation !== normalizedTeam(game.homeTeam) || awayAbbreviation !== normalizedTeam(game.awayTeam)) {
    throw new Error(`ESPN event teams do not match ${game.awayTeam} at ${game.homeTeam}.`);
  }
  const homeScore = optionalNumber(home.score);
  const awayScore = optionalNumber(away.score);
  const favoriteIsHome = normalizedTeam(game.favorite) === homeAbbreviation;
  const boxTeams = array(record(packageJson.boxscore).teams).map(record);
  const netPassingYards = boxTeams.map((team) => teamStatistic(team, "netPassingYards"));
  const combinedNetPassingYards = netPassingYards.length === 2 && netPassingYards.every((value) => value !== null)
    ? Number(netPassingYards[0]) + Number(netPassingYards[1])
    : null;
  const possessionTeam = competitors.find((team) => team.possession === true);

  return {
    state,
    status: state === "LIVE" ? "IN_PROGRESS" : state,
    statusText: String(statusType.shortDetail || statusType.detail || ""),
    favoriteScore: favoriteIsHome ? homeScore : awayScore,
    underdogScore: favoriteIsHome ? awayScore : homeScore,
    homeScore,
    awayScore,
    period: String(status.period || ""),
    clock: String(status.displayClock || ""),
    possession: normalizedTeam(record(record(possessionTeam).team).abbreviation),
    combinedNetPassingYards,
  };
};

export const espnEventId = (game: StoredGame): string =>
  String(game.metadata.espnEventId || "").trim();

export const isRefreshWindow = (games: StoredGame[], now = new Date()): boolean => {
  const dates = games.map((game) => {
    const match = game.externalId.match(/(?:^|\D)(20\d{6})/);
    if (!match) return null;
    const value = match[1];
    return Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)));
  }).filter((value): value is number => value !== null && Number.isFinite(value));
  if (!dates.length) return false;
  const day = 24 * 60 * 60 * 1000;
  return now.getTime() >= Math.min(...dates) - day && now.getTime() <= Math.max(...dates) + 2 * day;
};

export const fetchEspnGame = async (eventId: string): Promise<unknown> => {
  const response = await fetch(`https://cdn.espn.com/core/nfl/game?xhr=1&gameId=${encodeURIComponent(eventId)}`, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "FBP-Worker/1.0",
    },
  });
  if (!response.ok) throw new Error(`ESPN event ${eventId} returned HTTP ${response.status}.`);
  return response.json();
};