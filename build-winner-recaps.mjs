import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const archiveDirectory = path.join(root, "archive", "completed_regular_season");
const outputDirectory = path.join(root, "data", "winner-recaps");
const appsScriptUrl = "https://script.google.com/macros/s/AKfycbxZUgJm6LstCEomhmrlJYa_nH7tsmxC_4UZwYdroIZbs-PeI6KdPqUZtsF9fZvr_YuNWQ/exec";
const workerUrl = "https://fbp-api.fbp-api-worker.workers.dev/";

function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return rows.filter(columns => columns.some(Boolean)).map(columns => Object.fromEntries(headers.map((header, index) => [header, columns[index] ?? ""])));
}

const number = value => Number(value || 0);
const normalizeTeam = value => ({ JAC: "JAX", LA: "LAR", WSH: "WAS" }[String(value || "").trim().toUpperCase()] || String(value || "").trim().toUpperCase());
const normalizeName = value => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();

function summarizePlayers(rows) {
  const grouped = new Map();
  rows.forEach(row => {
    const name = String(row.Name || "").trim();
    if (!grouped.has(name)) {
      grouped.set(name, {
        name,
        weekName: String(row["Week Name"] || "").trim(),
        bestBet: normalizeTeam(row["Best Bet"]),
        tiebreaker: number(row.Tiebreaker),
        actualTiebreaker: number(row["Actual Tiebreak"]),
        tiebreakerDiff: number(row["Tiebreaker Diff"]),
        wins: 0,
        losses: 0,
        pushes: 0,
        picks: [],
      });
    }
    const player = grouped.get(name);
    player.wins += number(row["Result Win"]) + number(row["BB Win"]);
    player.losses += number(row["Result Loss"]) + number(row["BB Loss"]) + number(row["BB Push"]);
    player.pushes += number(row["Result Push"]);
    player.picks[number(row["Game Num"]) - 1] = normalizeTeam(row.Pick);
  });
  return [...grouped.values()].sort((left, right) => right.wins - left.wins || left.tiebreakerDiff - right.tiebreakerDiff || left.name.localeCompare(right.name));
}

function summarizeGames(rows, players) {
  const firstPlayer = players[0]?.name;
  return rows.filter(row => row.Name === firstPlayer).sort((left, right) => number(left["Game Num"]) - number(right["Game Num"])).map(row => {
    const favorite = normalizeTeam(row.Favorite);
    const underdog = normalizeTeam(row.Underdog);
    const spread = number(row.Spread);
    const favoriteScore = number(row["Fav Score"]);
    const underdogScore = number(row["Und Score"]);
    const margin = favoriteScore - underdogScore - spread;
    return {
      gameNum: number(row["Game Num"]),
      date: row["Game Date"],
      day: row["Game Day"],
      time: row["Game Time"],
      favorite,
      underdog,
      spread,
      home: normalizeTeam(row.Home),
      away: normalizeTeam(row.Away),
      favoriteScore,
      underdogScore,
      homeScore: number(row["Home Score"]),
      awayScore: number(row["Away Score"]),
      winner: margin === 0 ? "PUSH" : margin > 0 ? favorite : underdog,
      state: "FINAL",
    };
  });
}

function buildHighlights(players, games, rows, winner) {
  const playerCount = players.length;
  const winnerRows = rows.filter(row => row.Name === winner.name).sort((left, right) => number(left["Game Num"]) - number(right["Game Num"]));
  const picks = winnerRows.map(row => {
    const gameNum = number(row["Game Num"]);
    const pick = normalizeTeam(row.Pick);
    const support = rows.filter(candidate => number(candidate["Game Num"]) === gameNum && normalizeTeam(candidate.Pick) === pick).length;
    const correct = number(row["Result Win"]) > 0;
    return { gameNum, pick, support, correct, bestBet: normalizeTeam(row["Best Bet"]) === pick };
  });
  const sharpest = picks.filter(pick => pick.correct && pick.support <= playerCount / 2).sort((left, right) => left.support - right.support || left.pick.localeCompare(right.pick)).slice(0, 2);
  const underdogs = winnerRows.filter(row => normalizeTeam(row.Pick) === normalizeTeam(row.Underdog));
  const helpedRaw = games.map((game, index) => {
    const winnerPick = winner.picks[index];
    const points = players.map(player => {
      if (game.winner === "PUSH" || player.picks[index] !== game.winner) return 0;
      return 1 + (player.bestBet === game.winner ? 1 : 0);
    });
    const winnerPoints = points[players.indexOf(winner)];
    const field = points.filter((_, playerIndex) => players[playerIndex] !== winner);
    const fieldAverage = field.length ? field.reduce((total, value) => total + value, 0) / field.length : 0;
    return { gameNum: game.gameNum, matchup: `${game.away} at ${game.home}`, pick: winnerPick, result: game.winner === "PUSH" ? "Push" : winnerPick === game.winner ? winner.bestBet === winnerPick ? "Win + Best Bet" : "Win" : "Loss", impact: winnerPoints - fieldAverage };
  });
  const totalPositive = helpedRaw.reduce((total, item) => total + Math.max(0, item.impact), 0) || 1;
  const ranked = [...helpedRaw].sort((left, right) => right.impact - left.impact || left.gameNum - right.gameNum);
  const helped = helpedRaw.map(item => ({ ...item, percent: 100 * item.impact / totalPositive, rank: ranked.indexOf(item) + 1 }));
  return {
    correctPicks: picks.filter(pick => pick.correct).length,
    underdogPicks: underdogs.length,
    correctUnderdogs: underdogs.filter(row => number(row["Result Win"]) > 0).length,
    sharpest,
    helped,
  };
}

async function fetchJson(url) {
  const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}winnerArchive=${Date.now()}`);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function raceCandidateScore(snapshots, winnerNames) {
  const maxPlayers = snapshots.reduce((maximum, frame) => Math.max(maximum, frame.players?.length || 0), 0);
  const winnerFrames = snapshots.filter(frame => winnerNames.some(name => frame.players?.some(player => normalizeName(player.name) === normalizeName(name)))).length;
  return winnerFrames * 1000 + maxPlayers * 100 + snapshots.length;
}

async function loadRaceArchive(season, week, winnerNames) {
  const urls = [
    { name: "Apps Script race archive", url: `${appsScriptUrl}?action=race-archive&season=${season}&week=${week}` },
    { name: "D1 race archive", url: `${workerUrl}?action=race-archive&season=${season}&week=${week}` },
  ];
  const candidates = await Promise.all(urls.map(async source => {
    try {
      const data = await fetchJson(source.url);
      return { source: source.name, snapshots: Array.isArray(data.raceSnapshots) ? data.raceSnapshots : [] };
    } catch (error) {
      console.warn(`${source.name} unavailable for ${season} Week ${week}: ${error.message}`);
      return { source: source.name, snapshots: [] };
    }
  }));
  return candidates.sort((left, right) => raceCandidateScore(right.snapshots, winnerNames) - raceCandidateScore(left.snapshots, winnerNames))[0];
}

function careerSummary(winnerName, playerWeeks, moneyRows) {
  const rows = playerWeeks.filter(row => normalizeName(row.name) === normalizeName(winnerName));
  const weeklyWins = rows.filter(row => row.competition === "regular" && number(row.rank) === 1).length;
  const playoffWins = new Set(rows.filter(row => number(row.playoffAward) > 0).map(row => row.season)).size;
  const seasonChampionships = new Set(rows.filter(row => number(row.seasonAward) > 0).map(row => row.season)).size;
  const money = number(moneyRows.find(row => normalizeName(row.Name) === normalizeName(winnerName))?.["Total Money Won"]);
  return { money, weeklyWins, playoffWins, seasonChampionships };
}

async function main() {
  const [files, playerWeeks, moneyRows] = await Promise.all([
    readdir(archiveDirectory),
    readFile(path.join(root, "data", "player_weeks.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "data", "money_won.json"), "utf8").then(JSON.parse),
  ]);
  const archiveFiles = files.filter(file => /^\d{4}-\d{4}_week_\d{2}\.csv$/.test(file)).sort();
  await mkdir(outputDirectory, { recursive: true });
  const index = [];
  for (const file of archiveFiles) {
    const match = file.match(/^(\d{4})-\d{4}_week_(\d{2})\.csv$/);
    const season = Number(match[1]);
    const week = Number(match[2]);
    const rows = parseCsv(await readFile(path.join(archiveDirectory, file), "utf8"));
    const players = summarizePlayers(rows);
    if (!players.length) continue;
    const winningWins = players[0].wins;
    const winningDiff = players.filter(player => player.wins === winningWins).reduce((minimum, player) => Math.min(minimum, player.tiebreakerDiff), Number.POSITIVE_INFINITY);
    const winners = players.filter(player => player.wins === winningWins && player.tiebreakerDiff === winningDiff);
    const games = summarizeGames(rows, players);
    const race = await loadRaceArchive(season, week, winners.map(winner => winner.name));
    const primaryWinner = winners[0];
    const output = {
      schemaVersion: 1,
      season,
      seasonLabel: `${season}-${season + 1}`,
      week,
      archiveFile: file,
      generatedAt: new Date().toISOString(),
      winners: winners.map(winner => ({ ...winner, career: careerSummary(winner.name, playerWeeks, moneyRows), highlights: buildHighlights(players, games, rows, winner) })),
      players,
      games,
      raceSource: race.source,
      raceSnapshots: race.snapshots,
    };
    const outputFile = `${season}-${season + 1}_week_${String(week).padStart(2, "0")}.json`;
    await writeFile(path.join(outputDirectory, outputFile), JSON.stringify(output));
    index.push({
      season,
      seasonLabel: output.seasonLabel,
      week,
      winners: winners.map(winner => winner.name),
      record: `${primaryWinner.wins}-${primaryWinner.losses}${primaryWinner.pushes ? `-${primaryWinner.pushes}` : ""}`,
      weekName: primaryWinner.weekName,
      file: outputFile,
      raceFrames: race.snapshots.length,
    });
    console.log(`Built ${outputFile}: ${winners.map(winner => winner.name).join(" / ")} with ${race.snapshots.length} race frames from ${race.source}.`);
  }
  await writeFile(path.join(outputDirectory, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), weeks: index }));
}

await main();
