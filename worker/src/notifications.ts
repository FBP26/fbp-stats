export const notificationEvents = [
  "picksReady",
  "picksDue",
  "firstPlace",
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
  earlyWindow: "early_window",
  lateWindow: "late_window",
  beforeSnf: "before_snf",
  beforeMnf: "before_mnf",
  weeklyResult: "weekly_result",
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
  const allSpreadsReady = games.length > 0 && games.every((game) => game.spread !== "" && game.spread != null && Number.isFinite(Number(game.spread)));
  if (["staged", "open"].includes(weekStatus) && allSpreadsReady) events.add("picksReady");
  if (weekStatus === "finalized") events.add("weeklyResult");
  const timed = games.map((game) => ({ game, kickoff: easternKickoff(game.kickoff) })).filter((item) => item.kickoff);
  const final = (item: typeof timed[number]) => String(item.game.state) === "FINAL";
  const early = timed.filter((item) => item.kickoff?.day === "Sun" && Number(item.kickoff.hour) < 16);
  const late = timed.filter((item) => item.kickoff?.day === "Sun" && Number(item.kickoff.hour) >= 16 && Number(item.kickoff.hour) < 20);
  const sundayNight = timed.filter((item) => item.kickoff?.day === "Sun" && Number(item.kickoff.hour) >= 20);
  const mondayNight = timed.filter((item) => item.kickoff?.day === "Mon" && Number(item.kickoff.hour) >= 19);
  if (early.length && early.every(final)) events.add("earlyWindow");
  if (late.length && [...early, ...late].every(final)) events.add("lateWindow");
  const beginsSoon = (item: typeof timed[number]) => {
    const milliseconds = Number(item.kickoff?.time) - now.getTime();
    return String(item.game.state) === "PREGAME" && milliseconds >= 0 && milliseconds <= 35 * 60 * 1000;
  };
  if (sundayNight.some(beginsSoon)) events.add("beforeSnf");
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
