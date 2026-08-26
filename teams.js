let teamsAnalytics = null;
const teamsBarValueLabels = {
  id: "teamsBarValueLabels",
  afterDatasetsDraw(chart) {
    const context = chart.ctx;
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const meta = chart.getDatasetMeta(datasetIndex);
      context.save();
      context.font = "bold 11px Arial";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = "#0d1117";
      meta.data.forEach((bar, index) => {
        const text = dataset.barText?.[index], lines = (Array.isArray(text) ? text : [text]).filter(Boolean);
        if (!lines.length || bar.base == null) return;
        const horizontal = chart.options.indexAxis === "y";
        const visibleBase = horizontal ? Math.max(chart.chartArea.left, Math.min(chart.chartArea.right, bar.base)) : Math.max(chart.chartArea.top, Math.min(chart.chartArea.bottom, bar.base));
        const width = Math.max(...lines.map(line => context.measureText(line).width)), labelHeight = lines.length * 12, length = horizontal ? Math.abs(bar.x - visibleBase) : Math.abs(bar.y - visibleBase), outside = horizontal ? length < width + 12 : length < labelHeight + 10;
        context.fillStyle = outside ? "#e8eef5" : "#0d1117";
        const x = outside ? Math.min(chart.chartArea.right - width / 2, Math.max(chart.chartArea.left + width / 2, bar.x + width / 2 + 6)) : horizontal ? (bar.x + visibleBase) / 2 : bar.x;
        const centerY = horizontal ? bar.y : outside ? Math.max(chart.chartArea.top + labelHeight / 2, visibleBase - labelHeight / 2 - 6) : (bar.y + visibleBase) / 2;
        lines.forEach((line, lineIndex) => context.fillText(line, x, centerY + (lineIndex - (lines.length - 1) / 2) * 12));
      });
      context.restore();
    });
  }
};

function emptyTeamStat(team, season) {
  return {
    team, season, picks: 0, wins: 0, losses: 0, pushes: 0,
    fades: 0, fadeWins: 0, fadeLosses: 0, fadePushes: 0,
    bestBets: 0, bestBetWins: 0, bestBetLosses: 0, bestBetPushes: 0,
    consensusWins: 0, consensusLosses: 0, lowWins: 0, lowLosses: 0, lowPushes: 0,
    games: 0, covers: 0, noCovers: 0, gamePushes: 0, supportShareTotal: 0, supportGames: 0
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
    const hasBestBetResult = Number(pick.bestBetWin || 0) || Number(pick.bestBetLoss || 0) || Number(pick.bestBetPush || 0);
    if (hasBestBetResult && teams.includes(bestBet)) eachScope(bestBet, game.season, row => {
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
      const push = direct ? Number(direct.resultPush || 0) : Number(opposite?.resultPush || 0);
      eachScope(team, game.season, row => {
        row.supportShareTotal += share;
        row.supportGames += 1;
        if (win || loss || push) {
          row.games += 1;
          row.covers += win;
          row.noCovers += loss;
          row.gamePushes += push;
        }
        if (share > 0.5) {
          row.consensusWins += win;
          row.consensusLosses += loss;
        }
        if (share < 0.2) {
          row.lowWins += win;
          row.lowLosses += loss;
          row.lowPushes += push;
        }
      });
    });
  });
  teamsAnalytics = { stats, gameById, picksByGame };
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
      lowRate: teamRate(row.lowWins, row.lowLosses),
      supportRate: row.supportGames ? row.supportShareTotal / row.supportGames : 0,
      coverRate: teamRate(row.covers, row.noCovers)
    }));
}

function setupTeamsSections() {
  const panel = document.querySelector("#view-teams > .panel");
  const charts = panel?.querySelector(".profile-charts");
  if (!panel || !charts || document.getElementById("teams-global-section")) return;
  const chartPanels = [...charts.children];
  const headings = [...panel.querySelectorAll(":scope > h3")];
  const headingFor = text => headings.find(heading => heading.textContent.trim() === text);
  const globalSection = document.createElement("section");
  globalSection.id = "teams-global-section";
  globalSection.innerHTML = '<h3 class="teams-section-title">All-Team Comparison</h3><div class="profile-charts" id="teams-global-charts"></div>';
  const selectedSection = document.createElement("section");
  selectedSection.id = "teams-selected-section";
  selectedSection.innerHTML = '<hr class="chart-divider"><h3 class="teams-section-title" id="teams-selected-title">Selected Team</h3><div id="teams-selected-summary"></div><div class="profile-charts" id="teams-selected-charts"></div>';
  charts.before(globalSection, selectedSection);
  const sharedControls = panel.querySelector(":scope > .explorer-controls");
  const teamLabel = document.getElementById("teams-team")?.closest("label"), metricLabel = document.getElementById("teams-metric")?.closest("label");
  const globalControls = document.createElement("div"), selectedControls = document.createElement("div");
  globalControls.className = selectedControls.className = "explorer-controls";
  globalControls.style.marginBottom = selectedControls.style.marginBottom = "12px";
  if (metricLabel) globalControls.append(metricLabel);
  if (teamLabel) selectedControls.append(teamLabel);
  globalSection.querySelector(".teams-section-title").after(globalControls);
  selectedSection.querySelector(".teams-section-title").after(selectedControls);
  if (sharedControls && !sharedControls.children.length) sharedControls.remove();
  globalSection.querySelector("#teams-global-charts").append(chartPanels[0]);
  selectedSection.querySelector("#teams-selected-summary").append(document.getElementById("teams-summary"));
  selectedSection.querySelector("#teams-selected-charts").append(...chartPanels.slice(1));
  ["Team leaderboard", "Best Bet records"].forEach(text => {
    const heading = headingFor(text);
    if (heading) globalSection.append(heading, heading.nextElementSibling);
  });
  const affinityHeading = document.getElementById("teams-affinity-title");
  if (affinityHeading) selectedSection.append(affinityHeading, document.getElementById("teams-affinity-table"));
  charts.remove();
}

function initializeTeamsControls() {
  setupTeamsSections();
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
  teamSelect.value = priorTeam || (teams.includes("ARI") ? "ARI" : teams[0] || "");
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
    ["Record when picked against", record(selected.fadeWins || 0, selected.fadeLosses || 0, selected.fadePushes || 0)],
    ["Best Bet record", record(selected.bestBetWins || 0, selected.bestBetLosses || 0, selected.bestBetPushes || 0)]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  document.getElementById("teams-selected-title").textContent = `${selectedTeam} Team Detail`;

  const config = {
    volume: { label: "Times picked", description: "Total individual picks on each team across the selected seasons. The number on each bar is the pick count; this measures pool attention, not ATS quality.", value: row => row.picks, eligible: row => row.picks > 0 },
    ats: { label: "Pick win %", description: "How often picks on each team won against the spread, with at least 20 graded picks. Bar labels are ATS win rates.", value: row => row.pickRate * 100, eligible: row => row.picks >= 20 },
    fade: { label: "Win % picking against", description: "How often the pool won by choosing each team's opponent against the spread, with at least 20 graded picks against. Bar labels are ATS win rates.", value: row => row.fadeRate * 100, eligible: row => row.fades >= 20 },
    bestbet: { label: "Best Bet win %", description: "How often Best Bets on each team won against the spread, with at least five graded Best Bets. Bar labels are hit rates.", value: row => row.bestBetRate * 100, eligible: row => row.bestBets >= 5 }
  }[metric];
  const leaders = rows.filter(config.eligible)
    .sort((left, right) => config.value(right) - config.value(left) || right.picks - left.picks).slice(0, 12);
  if (teamsLeaderChart) teamsLeaderChart.destroy();
  let leaderNote = document.getElementById("teams-leader-note");
  if (!leaderNote) {
    leaderNote = document.createElement("p");
    leaderNote.id = "teams-leader-note";
    leaderNote.className = "analysis-note";
    document.getElementById("teams-leader-chart").closest(".profile-chart").querySelector(".panel-head").after(leaderNote);
  }
  leaderNote.textContent = config.description;
  const leaderBarText = row => metric === "volume" ? row.picks.toLocaleString() : pct(metric === "fade" ? row.fadeRate : metric === "bestbet" ? row.bestBetRate : row.pickRate);
  teamsLeaderChart = new Chart(document.getElementById("teams-leader-chart"), {
    type: "bar",
    data: { labels: leaders.map(row => row.team), datasets: [{
      label: config.label,
      data: leaders.map(config.value),
      barText: leaders.map(leaderBarText),
      backgroundColor: leaders.map(row => row.team === selectedTeam ? "#54d6b2bb" : "#8ca7ff99"),
      borderColor: leaders.map(row => row.team === selectedTeam ? "#54d6b2" : "#8ca7ff"), borderWidth: 1
    }] },
    plugins: [teamsBarValueLabels],
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, layout: { padding: { top: 8 } },
      scales: { x: { beginAtZero: metric === "volume", ticks: { color: "#91a0ae", callback: value => metric === "volume" ? value : value + "%" }, grid: { color: "#2a3744" } }, y: { ticks: { color: "#e8eef5" }, grid: { color: "#2a3744" } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { afterBody: items => { const row = leaders[items[0].dataIndex]; return [`Picked: ${record(row.wins, row.losses, row.pushes)} (${pct(row.pickRate)})`, `Picked against: ${record(row.fadeWins, row.fadeLosses, row.fadePushes)} (${pct(row.fadeRate)})`, `Best Bets: ${record(row.bestBetWins, row.bestBetLosses, row.bestBetPushes)} (${pct(row.bestBetRate)})`]; } } } }
    }
  });

  const seasons = [...new Set(websiteGames.map(game => game.season))].sort();
  const trend = seasons.map(item => teamRowsForSeason(item).find(row => row.team === selectedTeam) || emptyTeamStat(selectedTeam, item));
  const qualifiedTrend = trend.filter(row => row.supportGames && row.games);
  const mostTrusted = [...qualifiedTrend].sort((left, right) => right.supportRate - left.supportRate)[0];
  const bestCover = [...qualifiedTrend].sort((left, right) => right.coverRate - left.coverRate)[0];
  document.getElementById("teams-trend-title").textContent = `${selectedTeam}: Pool Pick Share vs ATS Cover Rate`;
  document.getElementById("teams-trend-note").textContent = mostTrusted && bestCover ? `Blue is the average percentage of players who picked ${selectedTeam} in each game; above 50% means the pool usually chose them. Green is the percentage of ${selectedTeam} games that covered; above 50% is a winning ATS season. Peak pick share was ${mostTrusted.season} (${pct(mostTrusted.supportRate)}); best cover rate was ${bestCover.season} (${pct(bestCover.coverRate)}).` : "Blue is average pick share; green is the team's ATS cover rate.";
  if (teamsTrendChart) teamsTrendChart.destroy();
  teamsTrendChart = new Chart(document.getElementById("teams-trend-chart"), {
    type: "line",
    data: { labels: seasons, datasets: [
      { label: `Pool support for ${selectedTeam}`, data: trend.map(row => row.supportGames ? Number((row.supportRate * 100).toFixed(1)) : null), borderColor: "#8ca7ff", backgroundColor: "#8ca7ff", tension: .2 },
      { label: `${selectedTeam} ATS cover rate`, data: trend.map(row => row.games ? Number((row.coverRate * 100).toFixed(1)) : null), borderColor: "#54d6b2", backgroundColor: "#54d6b2", tension: .2 },
      { label: "50% break-even", data: seasons.map(() => 50), borderColor: "#91a0ae", backgroundColor: "#91a0ae", borderDash: [5, 5], pointRadius: 0, borderWidth: 1 }
    ] },
    options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false }, scales: { x: { ticks: { color: "#91a0ae", maxRotation: 60, minRotation: 45 }, grid: { color: "#2a3744" } }, y: { beginAtZero: true, max: 100, ticks: { color: "#91a0ae", callback: value => value + "%" }, grid: { color: "#2a3744" } } }, plugins: { legend: { labels: { color: "#e8eef5", filter: item => item.text !== "50% break-even" } }, tooltip: { filter: item => item.dataset.label !== "50% break-even", callbacks: { afterBody: items => { const row = trend[items[0].dataIndex]; return [`Average support: ${pct(row.supportRate)} across ${row.supportGames} games`, `Team ATS: ${record(row.covers, row.noCovers, row.gamePushes)} (${pct(row.coverRate)})`]; } } } } }
  });

  const opponentStats = new Map();
  websiteGames.filter(game => (season === "all" || game.season === season) && [game.favorite, game.underdog].map(value => String(value || "").toUpperCase()).includes(selectedTeam)).forEach(game => {
    const teams = [game.favorite, game.underdog].map(value => String(value || "").toUpperCase()), opponent = teams.find(team => team !== selectedTeam);
    const gamePicks = (buildTeamsAnalytics().picksByGame.get(game.gameId) || []).filter(pick => pick.pick);
    const direct = gamePicks.find(pick => String(pick.pick || "").toUpperCase() === selectedTeam), opposite = gamePicks.find(pick => String(pick.pick || "").toUpperCase() !== selectedTeam);
    if (!opponent || (!direct && !opposite)) return;
    const win = direct ? Number(direct.resultWin || 0) : Number(opposite.resultLoss || 0), loss = direct ? Number(direct.resultLoss || 0) : Number(opposite.resultWin || 0), push = direct ? Number(direct.resultPush || 0) : Number(opposite.resultPush || 0);
    if (!(win || loss || push)) return;
    const row = opponentStats.get(opponent) || { opponent, wins: 0, losses: 0, pushes: 0, meetings: [] };
    row.wins += win; row.losses += loss; row.pushes += push; row.meetings.push({ season: game.season, week: game.week, spread: game.spread, win, loss, push });
    opponentStats.set(opponent, row);
  });
  const allOpponents = [...opponentStats.values()].map(row => ({ ...row, rate: teamRate(row.wins, row.losses) }));
  const repeatOpponents = allOpponents.filter(row => row.meetings.length >= 3), opponents = (repeatOpponents.length ? repeatOpponents : allOpponents).sort((left, right) => right.rate - left.rate || right.meetings.length - left.meetings.length || left.opponent.localeCompare(right.opponent)).slice(0, 10);
  document.getElementById("teams-consensus-title").textContent = `${selectedTeam}: Best ATS Matchups`;
  document.getElementById("teams-consensus-note").textContent = opponents.length ? `How often ${selectedTeam} covered against each specific opponent. The chart prefers matchups with at least three archived meetings and shows up to ten, ordered by cover rate.` : `No graded matchup history is available for ${selectedTeam} in the selected seasons.`;
  if (teamsConsensusChart) teamsConsensusChart.destroy();
  document.getElementById("teams-consensus-chart").parentElement.style.height = `${Math.max(335, opponents.length * 30 + 70)}px`;
  teamsConsensusChart = new Chart(document.getElementById("teams-consensus-chart"), {
    type: "bar",
    data: { labels: opponents.map(row => `${selectedTeam} vs ${row.opponent}`), datasets: [{ label: "ATS cover %", data: opponents.map(row => Number((row.rate * 100).toFixed(1))), barText: opponents.map(row => [`${(row.rate * 100).toFixed(1)}%`, record(row.wins, row.losses, row.pushes)]), backgroundColor: opponents.map(row => row.rate >= .5 ? "#54d6b299" : "#ff8f7099"), borderColor: opponents.map(row => row.rate >= .5 ? "#54d6b2" : "#ff8f70"), borderWidth: 1 }] },
    plugins: [teamsBarValueLabels],
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, scales: { x: { beginAtZero: true, max: 100, ticks: { color: "#91a0ae", callback: value => value + "%" }, grid: { color: "#2a3744" } }, y: { ticks: { color: "#e8eef5" }, grid: { color: "#2a3744" } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { afterBody: items => { const row = opponents[items[0].dataIndex], seasons = [...new Set(row.meetings.map(meeting => meeting.season))]; return [`${selectedTeam} ATS: ${record(row.wins, row.losses, row.pushes)} (${pct(row.rate)})`, `${row.meetings.length} archived meetings`, `Seasons: ${seasons[0]}${seasons.length > 1 ? ` to ${seasons.at(-1)}` : ""}`, ...row.meetings.slice(-3).reverse().map(meeting => `${meeting.season} ${String(meeting.week).toLowerCase().includes("round") || String(meeting.week).toLowerCase().includes("bowl") ? meeting.week : `W${meeting.week}`} · ${selectedTeam} ${meeting.win ? "covered" : meeting.loss ? "did not cover" : "pushed"} · spread ${meeting.spread}`)]; } } } } }
  });

  const venueSplits = [
    { label: "Neutral site", neutral: true, wins: 0, losses: 0, pushes: 0, games: new Set() },
    { label: "Traditional venue", neutral: false, wins: 0, losses: 0, pushes: 0, games: new Set() }
  ];
  websitePicks.forEach(pick => {
    const game = buildTeamsAnalytics().gameById.get(pick.gameId);
    if (!game || (season !== "all" && game.season !== season) || String(pick.pick || "").toUpperCase() !== selectedTeam) return;
    const split = venueSplits[websiteIsNeutralSite(game) ? 0 : 1];
    const win = Number(pick.resultWin || 0), loss = Number(pick.resultLoss || 0), push = Number(pick.resultPush || 0);
    if (!(win || loss || push)) return;
    split.wins += win; split.losses += loss; split.pushes += push; split.games.add(game.gameId);
  });
  venueSplits.forEach(split => { split.rate = teamRate(split.wins, split.losses); });
  const neutral = venueSplits[0], traditional = venueSplits[1];
  document.getElementById("teams-neutral-title").textContent = `${selectedTeam}: Neutral-Site Picks`;
  document.getElementById("teams-neutral-note").textContent = neutral.games.size
    ? `Pool picks on ${selectedTeam} at NFL-designated neutral sites compared with all other venues. Neutral sample: ${neutral.games.size} games and ${neutral.wins + neutral.losses + neutral.pushes} picks; records use the pool's archived spreads.`
    : `No archived picks on ${selectedTeam} at an NFL-designated neutral site are available for the selected seasons.`;
  if (teamsNeutralChart) teamsNeutralChart.destroy();
  teamsNeutralChart = new Chart(document.getElementById("teams-neutral-chart"), {
    type: "bar",
    data: { labels: venueSplits.map(split => split.label), datasets: [{ label: "ATS win % when picked", data: venueSplits.map(split => split.wins + split.losses ? Number((split.rate * 100).toFixed(1)) : null), barText: venueSplits.map(split => split.wins + split.losses + split.pushes ? [`${(split.rate * 100).toFixed(1)}%`, record(split.wins, split.losses, split.pushes)] : "No picks"), backgroundColor: ["#ffb454aa", "#8ca7ffaa"], borderColor: ["#ffb454", "#8ca7ff"], borderWidth: 1 }] },
    plugins: [teamsBarValueLabels],
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: "#e8eef5" }, grid: { color: "#2a3744" } }, y: { beginAtZero: true, max: 100, ticks: { color: "#91a0ae", callback: value => value + "%" }, grid: { color: "#2a3744" } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { afterBody: items => { const split = venueSplits[items[0].dataIndex]; return [`Record: ${record(split.wins, split.losses, split.pushes)}`, `Individual picks: ${split.wins + split.losses + split.pushes}`, `Games represented: ${split.games.size}`, split.neutral && split.games.size < 3 ? "Small game sample; treat this as descriptive." : ""]; } } } } }
  });

  const tableRows = [...rows].sort((left, right) => right.picks - left.picks).map(row => ({
    team: row.team, picks: row.picks, record: record(row.wins, row.losses, row.pushes), pickPct: row.pickRate,
    fades: row.fades, fadeRecord: record(row.fadeWins, row.fadeLosses, row.fadePushes), fadePct: row.fadeRate,
    bestBets: row.bestBets, bestBetRecord: record(row.bestBetWins, row.bestBetLosses, row.bestBetPushes), bestBetPct: row.bestBetRate
  }));
  if (teamsLeaderboardTable) teamsLeaderboardTable.destroy();
  teamsLeaderboardTable = new Tabulator("#teams-leaderboard-table", { data: tableRows, layout: "fitDataStretch", columns: [
    { title: "Team", field: "team" }, { title: "Picks", field: "picks", sorter: "number" }, { title: "Record", field: "record" }, { title: "Pick %", field: "pickPct", formatter: percentFormatter, sorter: "number" },
    { title: "Picked against", field: "fades", sorter: "number" }, { title: "Against record", field: "fadeRecord" }, { title: "Against win %", field: "fadePct", formatter: percentFormatter, sorter: "number" }
  ] });
  if (teamsBestBetTable) teamsBestBetTable.destroy();
  teamsBestBetTable = new Tabulator("#teams-bestbet-table", { data: tableRows.filter(row => row.bestBets).sort((left, right) => right.bestBets - left.bestBets), layout: "fitDataStretch", columns: [
    { title: "Team", field: "team" }, { title: "Best Bets", field: "bestBets", sorter: "number" }, { title: "Record", field: "bestBetRecord" }, { title: "Hit rate", field: "bestBetPct", formatter: percentFormatter, sorter: "number" }
  ] });

  const affinity = new Map();
  websitePicks.forEach(pick => {
    const game = buildTeamsAnalytics().gameById.get(pick.gameId);
    if (!game || (season !== "all" && game.season !== season) || !pick.pick) return;
    const row = affinity.get(pick.playerId) || { player: pick.name || websitePlayers.find(player => player.playerId === pick.playerId)?.name || pick.playerId, totalPicks: 0, picks: 0, wins: 0, losses: 0, pushes: 0, bestBets: 0, bestBetWins: 0, bestBetLosses: 0, bestBetPushes: 0, against: 0, againstWins: 0, againstLosses: 0, againstPushes: 0 };
    row.totalPicks += 1;
    const picked = String(pick.pick || "").toUpperCase();
    const teams = [game.favorite, game.underdog].map(value => String(value || "").toUpperCase());
    if (picked === selectedTeam) {
      row.picks += 1; row.wins += Number(pick.resultWin || 0); row.losses += Number(pick.resultLoss || 0); row.pushes += Number(pick.resultPush || 0);
    } else if (teams.includes(selectedTeam)) {
      row.against += 1; row.againstWins += Number(pick.resultWin || 0); row.againstLosses += Number(pick.resultLoss || 0); row.againstPushes += Number(pick.resultPush || 0);
    }
    const hasBestBetResult = Number(pick.bestBetWin || 0) || Number(pick.bestBetLoss || 0) || Number(pick.bestBetPush || 0);
    if (hasBestBetResult && String(pick.bestBet || "").toUpperCase() === selectedTeam) {
      row.bestBets += 1; row.bestBetWins += Number(pick.bestBetWin || 0); row.bestBetLosses += Number(pick.bestBetLoss || 0); row.bestBetPushes += Number(pick.bestBetPush || 0);
    }
    affinity.set(pick.playerId, row);
  });
  const affinityRows = [...affinity.values()].filter(row => row.picks || row.against || row.bestBets).map(row => ({
    ...row,
    affinityPct: row.totalPicks ? row.picks / row.totalPicks : 0,
    record: record(row.wins, row.losses, row.pushes), winPct: teamRate(row.wins, row.losses),
    bestBetRecord: record(row.bestBetWins, row.bestBetLosses, row.bestBetPushes), bestBetPct: teamRate(row.bestBetWins, row.bestBetLosses),
    againstRecord: record(row.againstWins, row.againstLosses, row.againstPushes), againstPct: teamRate(row.againstWins, row.againstLosses)
  })).sort((left, right) => right.picks - left.picks || right.affinityPct - left.affinityPct);
  document.getElementById("teams-affinity-title").textContent = `${selectedTeam} Player Affinity and Bet Against`;
  if (teamsAffinityTable) teamsAffinityTable.destroy();
  teamsAffinityTable = new Tabulator("#teams-affinity-table", { data: affinityRows, layout: "fitDataStretch", initialSort: [{ column: "picks", dir: "desc" }], columns: [
    { title: "Player", field: "player", frozen: true },
    { title: "Picked", field: "picks", sorter: "number" }, { title: "Pick share", field: "affinityPct", formatter: percentFormatter, sorter: "number" }, { title: "Record", field: "record" }, { title: "Win %", field: "winPct", formatter: percentFormatter, sorter: "number" },
    { title: "Best Bets", field: "bestBets", sorter: "number" }, { title: "BB record", field: "bestBetRecord" }, { title: "BB %", field: "bestBetPct", formatter: percentFormatter, sorter: "number" },
    { title: "Bet against", field: "against", sorter: "number" }, { title: "Against record", field: "againstRecord" }, { title: "Against %", field: "againstPct", formatter: percentFormatter, sorter: "number" }
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
