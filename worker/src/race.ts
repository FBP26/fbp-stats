export interface RaceSnapshotPlayer {
  name: string;
  winProbability: number;
  pathsToVictory: number;
}

type RacePlayerRecord = Record<string, unknown>;

export const validateRaceSnapshotPlayers = (
  value: unknown,
  authoritativeNames: string[],
): RaceSnapshotPlayer[] => {
  if (!Array.isArray(value) || value.length !== authoritativeNames.length || !value.length) {
    throw new Error("A race snapshot must include every current player exactly once.");
  }
  const allowedNames = new Set(authoritativeNames);
  const seenNames = new Set<string>();
  const players = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Every race snapshot player must be an object.");
    }
    const row = item as RacePlayerRecord;
    const name = String(row.name ?? "").trim();
    const winProbability = Number(row.winProbability);
    const pathsToVictory = Number(row.pathsToVictory);
    if (!allowedNames.has(name) || seenNames.has(name)) {
      throw new Error("Race snapshot players must match the current field.");
    }
    if (!Number.isFinite(winProbability) || winProbability < 0 || winProbability > 100) {
      throw new Error("Race win probabilities must be finite values from 0 through 100.");
    }
    if (!Number.isSafeInteger(pathsToVictory) || pathsToVictory < 0) {
      throw new Error("Race paths to victory must be non-negative integers.");
    }
    seenNames.add(name);
    return { name, winProbability, pathsToVictory };
  });
  const probabilityTotal = players.reduce((sum, player) => sum + player.winProbability, 0);
  if (Math.abs(probabilityTotal - 100) > 0.1) {
    throw new Error("Race win probabilities must total 100 percent.");
  }
  return players;
};