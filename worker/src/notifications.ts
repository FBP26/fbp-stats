export const notificationEvents = [
  "picksReady",
  "picksDue",
  "firstPlace",
  "topFive",
  "topTen",
  "leadChange",
  "earlyWindow",
  "lateWindow",
  "beforeSnf",
  "beforeMnf",
  "weeklyResult",
] as const;

export type NotificationEvent = typeof notificationEvents[number];
export type NotificationChannel = "email" | "sms";
export type NotificationPreferences = Record<NotificationEvent, boolean>;

export const defaultNotificationPreferences = (): NotificationPreferences => ({
  picksReady: true,
  picksDue: true,
  firstPlace: false,
  topFive: false,
  topTen: false,
  leadChange: false,
  earlyWindow: false,
  lateWindow: false,
  beforeSnf: false,
  beforeMnf: false,
  weeklyResult: true,
});

export const parseNotificationPreferences = (value: unknown): NotificationPreferences => {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const defaults = defaultNotificationPreferences();
  return Object.fromEntries(notificationEvents.map((event) => [event,
    typeof source[event] === "boolean" ? source[event] : defaults[event],
  ])) as NotificationPreferences;
};

export const normalizeNotificationDestination = (channel: NotificationChannel, value: unknown): string => {
  const destination = String(value ?? "").trim();
  if (channel === "email") {
    const normalized = destination.toLowerCase();
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new Error("Enter a valid email address.");
    }
    return normalized;
  }
  const digits = destination.replace(/\D/g, "");
  const normalized = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : "";
  if (!normalized) throw new Error("Enter a valid U.S. mobile number.");
  return normalized;
};

export const maskNotificationDestination = (channel: NotificationChannel, destination: string): string => {
  if (channel === "email") {
    const [local, domain] = destination.split("@");
    return `${local.slice(0, 1)}${"*".repeat(Math.min(Math.max(local.length - 1, 2), 8))}@${domain}`;
  }
  return `(***) ***-${destination.slice(-4)}`;
};

export const notificationPreferenceColumns: Record<NotificationEvent, string> = {
  picksReady: "picks_ready",
  picksDue: "picks_due",
  firstPlace: "first_place",
  topFive: "top_five",
  topTen: "top_ten",
  leadChange: "lead_change",
  earlyWindow: "early_window",
  lateWindow: "late_window",
  beforeSnf: "before_snf",
  beforeMnf: "before_mnf",
  weeklyResult: "weekly_result",
};

export interface WeeklyRecapPlayer {
  name: string;
  wins: number;
  losses: number;
  rank: number;
  tiebreakDifference?: number | null;
}

export const ordinalRank = (rank: number): string => {
  const suffix = rank % 100 >= 11 && rank % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[rank % 10] || "th");
  return `${rank}${suffix}`;
};

export const weeklyRecapMessage = (players: WeeklyRecapPlayer[], followedNames: string[]): string => {
  const followed = followedNames.map(name => players.find(player => player.name.toLowerCase() === name.toLowerCase())).filter((player): player is WeeklyRecapPlayer => Boolean(player));
  const personalResults = followed.map(player => {
    const tied = players.filter(other => other.wins === player.wins).length > 1;
    return `${player.name}: ${player.wins}-${player.losses}, ${tied ? "tied for " : ""}${ordinalRank(player.rank)}`;
  });
  const topWins = Math.max(...players.map(player => player.wins));
  const contenders = players.filter(player => player.wins === topWins);
  const tiebreakDifferences = contenders.map(player => Number(player.tiebreakDifference)).filter(Number.isFinite);
  const bestDifference = tiebreakDifferences.length === contenders.length ? Math.min(...tiebreakDifferences) : null;
  const winners = bestDifference === null ? contenders : contenders.filter(player => Number(player.tiebreakDifference) === bestDifference);
  return `${personalResults.join("; ")}. Winner${winners.length === 1 ? "" : "s"}: ${winners.map(player => player.name).join(" and ")}.`;
};

interface NotificationGame {
  kickoff?: unknown;
  state?: unknown;
  spread?: unknown;
}

const easternKickoff = (value: unknown): { day: string; hour: number; time: number } | null => {
  const time = Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(time));
  return {
    day: parts.find((part) => part.type === "weekday")?.value || "",
    hour: Number(parts.find((part) => part.type === "hour")?.value),
    time,
  };
};

export const scheduledNotificationEvents = (
  now: Date,
  games: NotificationGame[],
  weekStatus: string,
): NotificationEvent[] => {
  const events = new Set<NotificationEvent>();
  if (weekStatus === "finalized") events.add("weeklyResult");
  const timed = games.map((game) => ({ game, kickoff: easternKickoff(game.kickoff) })).filter((item) => item.kickoff);
  const final = (item: typeof timed[number]) => String(item.game.state) === "FINAL";
  const early = timed.filter((item) => item.kickoff?.day === "Sun" && Number(item.kickoff.hour) < 16);
  const late = timed.filter((item) => item.kickoff?.day === "Sun" && Number(item.kickoff.hour) >= 16 && Number(item.kickoff.hour) < 20);
  const sundayNight = timed.filter((item) => item.kickoff?.day === "Sun" && Number(item.kickoff.hour) >= 20);
  const mondayNight = timed.filter((item) => item.kickoff?.day === "Mon" && Number(item.kickoff.hour) >= 19);
  if (early.length && early.every(final)) events.add("earlyWindow");
  const beginsSoon = (item: typeof timed[number]) => {
    const milliseconds = Number(item.kickoff?.time) - now.getTime();
    return String(item.game.state) === "PREGAME" && milliseconds >= 0 && milliseconds <= 35 * 60 * 1000;
  };
  if (sundayNight.some(beginsSoon) && [...early, ...late].every(final)) events.add("beforeSnf");
  if (mondayNight.some(beginsSoon)) events.add("beforeMnf");
  return [...events];
};

export const picksDueReminderIsEligible = (
  now: Date,
  games: NotificationGame[],
  weekStatus: string,
  minutesBeforeKickoff: number,
): boolean => {
  if (!["staged", "open"].includes(weekStatus)) return false;
  const kickoffs = games.map((game) => easternKickoff(game.kickoff)?.time).filter((time): time is number => Number.isFinite(time));
  if (!kickoffs.length) return false;
  const untilFirstKickoff = Math.min(...kickoffs) - now.getTime();
  return untilFirstKickoff >= 0 && untilFirstKickoff <= minutesBeforeKickoff * 60 * 1000;
};
