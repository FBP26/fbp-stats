let teamsAnalytics = null;

function emptyTeamStat(team, season) {
  return {
    team, season, picks: 0, wins: 0, losses: 0, pushes: 0,
    fades: 0, fadeWins: 0, fadeLosses: 0, fadePushes: 0,
    bestBets: 0, bestBetWins: 0, bestBetLosses: 0, bestBetPushes: 0,
    consensusWins: 0, consensusLosses: 0, lowWins: 0, lowLosses: 0
  };
}

function buildTeamsAnalytics() {
  if (teamsAnalytics) return teamsAnalytics;
  const gameById = new Map(websiteGames.map(game => [game.gameId, game]));
  const stats = new Map();
  const picksByGame = new Map();
  const statFor = (team, season) => {
    const key = `${season}|${team}`;
    if (!stats.has(key)) stats.set(key, emptyTeamStat(team, season));
    return stats.get(key);
  };
  const eachScope = (team, season, callback) => {
    callback(statFor(team, season));
    callback(statFor(team, "all"));
  };

  websitePicks.forEach(pick => {
    const game = gameById.get(pick.gameId);
    if (!game) return;
    const gamePicks = picksByGame.get(game.gameId) || [];
    gamePicks.push(pick);
    picksByGame.set(game.gameId, gamePicks);
    const teams = [game.favorite, game.underdog].map(value => String(value || "").toUpperCase());
    const selected = String(pick.pick || "").toUpperCase();
    const opponent = teams.find(team => team !== selected);
    if (teams.includes(selected)) {
      eachScope(selected, game.season, row => {
        row.picks += 1;
        row.wins += Number(pick.resultWin || 0);
        row.losses += Number(pick.resultLoss || 0);
        row.pushes += Number(pick.resultPush || 0);
      });
      if (opponent) eachScope(opponent, game.season, row => {
        row.fades += 1;
        row.fadeWins += Number(pick.resultWin || 0);
        row.fadeLosses += Number(pick.resultLoss || 0);
        row.fadePushes += Number(pick.resultPush || 0);
      });
    }
    const bestBet = String(pick.bestBet || "").toUpperCase();
    if (teams.includes(bestBet)) eachScope(bestBet, game.season, row => {
      row.bestBets += 1;
      row.bestBetWins += Number(pick.bestBetWin || 0);
      row.bestBetLosses += Number(pick.bestBetLoss || 0);
      row.bestBetPushes += Number(pick.bestBetPush || 0);
    });
  });

  websiteGames.forEach(game => {
    const gamePicks = (picksByGame.get(game.gameId) || []).filter(pick => pick.pick);
    const teams = [game.favorite, game.underdog].map(value => String(value || "").toUpperCase()).filter(Boolean);
    if (!gamePicks.length || teams.length !== 2) return;
    teams.forEach(team => {
      const share = gamePicks.filter(pick => String(pick.pick || "").toUpperCase() === team).length / gamePicks.length;
      const direct = gamePicks.find(pick => String(pick.pick || "").toUpperCase() === team);
      const opposite = gamePicks.find(pick => String(pick.pick || "").toUpperCase() !== team);
      const win = direct ? Number(direct.resultWin || 0) : Number(opposite?.resultLoss || 0);
      const loss = direct ? Number(direct.resultLoss || 0) : Number(opposite?.resultWin || 0);
      eachScope(team, game.season, row => {
        if (share > 0.5) {
          row.consensusWins += win;
          row.consensusLosses += loss;
        }
        if (share < 0.2) {
          row.lowWins += win;
          row.lowLosses += loss;
        }
      });
    });
  });
  teamsAnalytics = { stats, gameById };
  return teamsAnalytics;
}

function teamRate(wins, losses) {
  return wins + losses ? wins / (wins + losses) : 0;
}

function teamRowsForSeason(season) {
  return [...buildTeamsAnalytics().stats.values()]
    .filter(row => row.season === season && row.picks + row.fades > 0)
    .map(row => ({
      ...row,
      pickRate: teamRate(row.wins, row.losses),
      fadeRate: teamRate(row.fadeWins, row.fadeLosses),
      bestBetRate: teamRate(row.bestBetWins, row.bestBetLosses),
      consensusRate: teamRate(row.consensusWins, row.consensusLosses),
      lowRate: teamRate(row.lowWins, row.lowLosses)
    }));
}

function initializeTeamsControls() {
  const seasonSelect = document.getElementById("teams-season");
  const teamSelect = document.getElementById("teams-team");
  const priorTeam = teamSelect.value;
  if (seasonSelect.options.length === 1) {
    [...new Set(websiteGames.map(game => game.season))].sort().reverse()
      .forEach(season => seasonSelect.add(new Option(season, season)));
  }
  const teams = [...new Set(websiteGames.flatMap(game => [game.favorite, game.underdog])
    .map(value => String(value || "").toUpperCase()).filter(Boolean))].sort();
  if (!teamSelect.options.length) teams.forEach(team => teamSelect.add(new Option(team, team)));
  teamSelect.value = priorTeam || (teams.includes("DAL") ? "DAL" : teams[0] || "");
  [seasonSelect, teamSelect, document.getElementById("teams-metric")]
    .forEach(select => select.onchange = renderTeams);
}

function renderTeams() {
  if (!websiteGames.length || !websitePicks.length) return;
  initializeTeamsControls();
  const season = document.getElementById("teams-season").value;
  const selectedTeam = document.getElementById("teams-team").value;
  const metric = document.getElementById("teams-metric").value;
  const rows = teamRowsForSeason(season);
  const selected = rows.find(row => row.team === selectedTeam) || emptyTeamStat(selectedTeam, season);
  const pct = value => `${(value * 100).toFixed(1)}%`;
  const record = (wins, losses, pushes) => `${wins}-${losses}${pushes ? `-${pushes}` : ""}`;

  document.getElementById("teams-summary").innerHTML = [
    ["Times picked", selected.picks || 0],
    ["Picked ATS", record(selected.wins || 0, selected.losses || 0, selected.pushes || 0)],
    ["Pick win %", pct(selected.pickRate || 0)],
    ["Pool fade record", record(selected.fadeWins || 0, selected.fadeLosses || 0, selected.fadePushes || 0)],
    ["Best Bet record", record(selected.bestBetWins || 0, selected.bestBetLosses || 0, selected.bestBetPushes || 0)]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");

  const config = {
    volume: { label: "Times picked", value: row => row.picks, eligible: row => row.picks > 0 },
    ats: { label: "Pick win %", value: row => row.pickRate * 100, eligible: row => row.picks >= 20 },
    fade: { label: "Fade win %", value: row => row.fadeRate * 100, eligible: row => row.fades >= 20 },
    bestbet: { label: "Best Bet win %", value: row => row.bestBetRate * 100, eligible: row => row.bestBets >= 5 }
  }[metric];
  const leaders = rows.filter(config.eligible)
    .sort((left, right) => config.value(right) - config.value(left) || right.picks - left.picks).slice(0, 12);
  if (teamsLeaderChart) teamsLeaderChart.destroy();
  teamsLeaderChart = new Chart(document.getElementById("teams-leader-chart"), {
    type: "bar",
    data: { labels: leaders.map(row => row.team), datasets: [{
      label: config.label,
      data: leaders.map(config.value),
      backgroundColor: leaders.map(row => row.team === selectedTeam ? "#54d6b2bb" : "#8ca7ff99"),
      borderColor: leaders.map(row => row.team === selectedTeam ? "#54d6b2" : "#8ca7ff"), borderWidth: 1
    }] },
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false,
      scales: { x: { beginAtZero: metric === "volume", ticks: { color: "#91a0ae", callback: value => metric === "volume" ? value : value + "%" }, grid: { color: "#2a3744" } }, y: { ticks: { color: "#e8eef5" }, grid: { color: "#2a3744" } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { afterBody: items => { const row = leaders[items[0].dataIndex]; return [`Picked: ${record(row.wins, row.losses, row.pushes)} (${pct(row.pickRate)})`, `Faded: ${record(row.fadeWins, row.fadeLosses, row.fadePushes)} (${pct(row.fadeRate)})`, `Best Bets: ${record(row.bestBetWins, row.bestBetLosses, row.bestBetPushes)} (${pct(row.bestBetRate)})`]; } } } }
    }
  });

  const seasons = [...new Set(websiteGames.map(game => game.season))].sort();
  const trend = seasons.map(item => teamRowsForSeason(item).find(row => row.team === selectedTeam) || emptyTeamStat(selectedTeam, item));
  document.getElementById("teams-trend-title").textContent = `${selectedTeam} by Season`;
  if (teamsTrendChart) teamsTrendChart.destroy();
  teamsTrendChart = new Chart(document.getElementById("teams-trend-chart"), {
    type: "line",
    data: { labels: seasons, datasets: [
      { label: "Picked ATS", data: trend.map(row => row.picks ? Number((teamRate(row.wins, row.losses) * 100).toFixed(1)) : null), borderColor: "#54d6b2", backgroundColor: "#54d6b2" },
      { label: "Faded", data: trend.map(row => row.fades ? Number((teamRate(row.fadeWins, row.fadeLosses) * 100).toFixed(1)) : null), borderColor: "#ffb454", backgroundColor: "#ffb454" },
      { label: "Best Bet", data: trend.map(row => row.bestBets ? Number((teamRate(row.bestBetWins, row.bestBetLosses) * 100).toFixed(1)) : null), borderColor: "#8ca7ff", backgroundColor: "#8ca7ff" }
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, scales: { x: { ticks: { color: "#91a0ae", maxRotation: 60, minRotation: 45 }, grid: { color: "#2a3744" } }, y: { beginAtZero: true, max: 100, ticks: { color: "#91a0ae", callback: value => value + "%" }, grid: { color: "#2a3744" } } }, plugins: { legend: { labels: { color: "#e8eef5" } } } }
  });

  const consensus = [
    { label: "All pool picks", wins: selected.wins || 0, losses: selected.losses || 0, rate: selected.pickRate || 0 },
    { label: "Majority backed", wins: selected.consensusWins || 0, losses: selected.consensusLosses || 0, rate: selected.consensusRate || 0 },
    { label: "Under 20% support", wins: selected.lowWins || 0, losses: selected.lowLosses || 0, rate: selected.lowRate || 0 }
  ];
  if (teamsConsensusChart) teamsConsensusChart.destroy();
  teamsConsensusChart = new Chart(document.getElementById("teams-consensus-chart"), {
    type: "bar",
    data: { labels: consensus.map(row => row.label), datasets: [{ label: "ATS win %", data: consensus.map(row => Number((row.rate * 100).toFixed(1))), backgroundColor: ["#8ca7ff99", "#54d6b299", "#ffb45499"], borderColor: ["#8ca7ff", "#54d6b2", "#ffb454"], borderWidth: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: "#91a0ae" }, grid: { color: "#2a3744" } }, y: { beginAtZero: true, max: 100, ticks: { color: "#91a0ae", callback: value => value + "%" }, grid: { color: "#2a3744" } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { afterBody: items => { const row = consensus[items[0].dataIndex]; return `Record: ${row.wins}-${row.losses}`; } } } } }
  });

  const tableRows = [...rows].sort((left, right) => right.picks - left.picks).map(row => ({
    team: row.team, picks: row.picks, record: record(row.wins, row.losses, row.pushes), pickPct: row.pickRate,
    fades: row.fades, fadeRecord: record(row.fadeWins, row.fadeLosses, row.fadePushes), fadePct: row.fadeRate,
    bestBets: row.bestBets, bestBetRecord: record(row.bestBetWins, row.bestBetLosses, row.bestBetPushes), bestBetPct: row.bestBetRate
  }));
  if (teamsLeaderboardTable) teamsLeaderboardTable.destroy();
  teamsLeaderboardTable = new Tabulator("#teams-leaderboard-table", { data: tableRows, layout: "fitDataStretch", pagination: true, paginationSize: 32, columns: [
    { title: "Team", field: "team" }, { title: "Picks", field: "picks", sorter: "number" }, { title: "Record", field: "record" }, { title: "Pick %", field: "pickPct", formatter: percentFormatter, sorter: "number" },
    { title: "Fades", field: "fades", sorter: "number" }, { title: "Fade record", field: "fadeRecord" }, { title: "Fade %", field: "fadePct", formatter: percentFormatter, sorter: "number" }
  ] });
  if (teamsBestBetTable) teamsBestBetTable.destroy();
  teamsBestBetTable = new Tabulator("#teams-bestbet-table", { data: tableRows.filter(row => row.bestBets).sort((left, right) => right.bestBets - left.bestBets), layout: "fitDataStretch", pagination: true, paginationSize: 16, columns: [
    { title: "Team", field: "team" }, { title: "Best Bets", field: "bestBets", sorter: "number" }, { title: "Record", field: "bestBetRecord" }, { title: "Hit rate", field: "bestBetPct", formatter: percentFormatter, sorter: "number" }
  ] });

  const affinity = new Map();
  websitePicks.forEach(pick => {
    const game = buildTeamsAnalytics().gameById.get(pick.gameId);
    if (!game || (season !== "all" && game.season !== season) || String(pick.pick || "").toUpperCase() !== selectedTeam) return;
    const row = affinity.get(pick.playerId) || { player: pick.name || websitePlayers.find(player => player.playerId === pick.playerId)?.name || pick.playerId, picks: 0, wins: 0, losses: 0, pushes: 0 };
    row.picks += 1; row.wins += Number(pick.resultWin || 0); row.losses += Number(pick.resultLoss || 0); row.pushes += Number(pick.resultPush || 0); affinity.set(pick.playerId, row);
  });
  const affinityRows = [...affinity.values()].map(row => ({ ...row, record: record(row.wins, row.losses, row.pushes), winPct: teamRate(row.wins, row.losses) })).sort((left, right) => right.picks - left.picks);
  document.getElementById("teams-affinity-title").textContent = `${selectedTeam} player affinity`;
  if (teamsAffinityTable) teamsAffinityTable.destroy();
  teamsAffinityTable = new Tabulator("#teams-affinity-table", { data: affinityRows, layout: "fitDataStretch", pagination: true, paginationSize: 20, columns: [
    { title: "Player", field: "player" }, { title: "Times picked", field: "picks", sorter: "number" }, { title: "Record", field: "record" }, { title: "Win %", field: "winPct", formatter: percentFormatter, sorter: "number" }
  ] });
}

async function loadTeamsView() {
  await loadDrilldown();
  showView("teams");
  renderTeams();
}

document.querySelector('button[data-view="teams"]').addEventListener("click", loadTeamsView);
if (location.hash === "#teams") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loadTeamsView, { once: true });
  else loadTeamsView();
}
