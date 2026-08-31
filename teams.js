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
        const width = Math.max(...lines.map(line => context.measureText(line).width)), labelHeight = lines.length * 12, length = horizontal ? Math.abs(bar.x - visibleBase) : Math.abs(bar.y - visibleBase), outside = dataset.forceInside ? false : horizontal ? length < width + 12 : length < labelHeight + 10;
        context.fillStyle = outside ? "#e8eef5" : "#0d1117";
        const x = outside ? Math.min(chart.chartArea.right - width / 2, Math.max(chart.chartArea.left + width / 2, bar.x + width / 2 + 6)) : horizontal ? (bar.x + visibleBase) / 2 : bar.x;
        const centerY = horizontal ? bar.y : outside ? Math.max(chart.chartArea.top + labelHeight / 2, visibleBase - labelHeight / 2 - 6) : (bar.y + visibleBase) / 2;
        lines.forEach((line, lineIndex) => context.fillText(line, x, centerY + (lineIndex - (lines.length - 1) / 2) * 12));
      });
      context.restore();
    });
  }
};

const teamsTrendGuides = {
  id: "teamsTrendGuides",
  beforeDatasetsDraw(chart) {
    const scale = chart.scales.y, breakEven = scale?.getPixelForValue(50), area = chart.chartArea;
    if (!area || !Number.isFinite(breakEven)) return;
    chart.ctx.save();
    chart.ctx.fillStyle = "rgba(57, 201, 130, .06)";
    chart.ctx.fillRect(area.left, area.top, area.right - area.left, breakEven - area.top);
    chart.ctx.fillStyle = "rgba(255, 107, 107, .045)";
    chart.ctx.fillRect(area.left, breakEven, area.right - area.left, area.bottom - breakEven);
    chart.ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const context = chart.ctx;
    context.save();
    context.font = "bold 10px Arial";
    context.textAlign = "left";
    context.textBaseline = "middle";
    chart.data.datasets.slice(0, 2).forEach((dataset, datasetIndex) => {
      const values = dataset.data.map(value => value == null ? NaN : Number(value)), lastIndex = values.findLastIndex(Number.isFinite), point = chart.getDatasetMeta(datasetIndex).data[lastIndex];
      if (!point) return;
      context.fillStyle = dataset.borderColor;
      context.fillText(`${datasetIndex ? "ATS" : "POOL"} ${values[lastIndex].toFixed(1)}%`, point.x + 7, point.y + (datasetIndex ? 8 : -8));
    });
    context.restore();
  }
};

function emptyTeamStat(team, season) {
  return {
    team, season, picks: 0, wins: 0, losses: 0, pushes: 0,
    fades: 0, fadeWins: 0, fadeLosses: 0, fadePushes: 0,
    bestBets: 0, bestBetsAgainst: 0, bestBetWins: 0, bestBetLosses: 0, bestBetPushes: 0,
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
    if (hasBestBetResult && teams.includes(bestBet)) {
      eachScope(bestBet, game.season, row => {
        row.bestBets += 1;
        row.bestBetWins += Number(pick.bestBetWin || 0);
        row.bestBetLosses += Number(pick.bestBetLoss || 0);
        row.bestBetPushes += Number(pick.bestBetPush || 0);
      });
      const bestBetOpponent = teams.find(team => team !== bestBet);
      if (bestBetOpponent) eachScope(bestBetOpponent, game.season, row => { row.bestBetsAgainst += 1; });
    }
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

function renderSortableTeamsSheet(host, rows, columns, defaultSort) {
  if (!host) return;
  const sortKey = host.dataset.sortKey || defaultSort, direction = host.dataset.sortDirection || "desc", column = columns.find(item => item.key === sortKey) || columns[0];
  const ordered = [...rows].sort((left, right) => { const leftValue = column.value(left), rightValue = column.value(right), result = typeof leftValue === "number" && typeof rightValue === "number" ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue)); return direction === "asc" ? result : -result; });
  host.innerHTML = `<div class="teams-sheet-wrap"><table class="teams-sheet"><thead><tr>${columns.map(item => `<th data-team-sort="${item.key}"${item.key === sortKey ? ` aria-sort="${direction === "asc" ? "ascending" : "descending"}"` : ""}>${websiteEscapeHtml(item.label)}${item.key === sortKey ? direction === "asc" ? " ↑" : " ↓" : ""}</th>`).join("")}</tr></thead><tbody>${ordered.map(row => `<tr>${columns.map(item => `<td>${item.html ? item.html(row) : websiteEscapeHtml(item.value(row))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  host.querySelectorAll("[data-team-sort]").forEach(header => header.onclick = () => { const key = header.dataset.teamSort; host.dataset.sortDirection = host.dataset.sortKey === key && direction === "desc" ? "asc" : "desc"; host.dataset.sortKey = key; renderSortableTeamsSheet(host, rows, columns, defaultSort); });
}

function teamsRateCell(value, label) {
  const percentage = Number(value || 0) * 100, resultClass = percentage >= 52 ? "positive" : percentage < 48 ? "negative" : "";
  return `<span class="teams-rate-cell ${resultClass}" style="--rate:${Math.max(0, Math.min(100, percentage))}"><span class="teams-rate-bar"></span><span>${websiteEscapeHtml(label)}</span></span>`;
}

function renderTeamBehavior(selectedTeam, season) {
  let host = document.getElementById("teams-behavior");
  if (!host) {
    host = document.createElement("div");
    host.id = "teams-behavior";
    host.className = "team-behavior";
    document.getElementById("teams-selected-summary").append(host);
  }
  const upper = value => String(value || "").toUpperCase();
  const kickoffHour = value => {
    const match = String(value || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return null;
    return Number(match[1]) % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0) + Number(match[2]) / 60;
  };
  const picksByGame = buildTeamsAnalytics().picksByGame;
  const rows = websiteGames.filter(game => (season === "all" || game.season === season) && [upper(game.favorite), upper(game.underdog)].includes(selectedTeam)).map(game => {
    const picks = (picksByGame.get(game.gameId) || []).filter(pick => pick.pick);
    const direct = picks.find(pick => upper(pick.pick) === selectedTeam);
    const opposite = picks.find(pick => upper(pick.pick) !== selectedTeam);
    return {
      game,
      win: direct ? Number(direct.resultWin || 0) : Number(opposite?.resultLoss || 0),
      loss: direct ? Number(direct.resultLoss || 0) : Number(opposite?.resultWin || 0),
      push: direct ? Number(direct.resultPush || 0) : Number(opposite?.resultPush || 0),
      support: picks.length ? picks.filter(pick => upper(pick.pick) === selectedTeam).length / picks.length : null
    };
  }).filter(row => row.win || row.loss || row.push);
  const record = selected => selected.reduce((total, row) => ({ wins: total.wins + row.win, losses: total.losses + row.loss, pushes: total.pushes + row.push }), { wins: 0, losses: 0, pushes: 0 });
  const rate = result => result.wins + result.losses ? result.wins / (result.wins + result.losses) : 0;
  const division = WEBSITE_TEAM_DIVISIONS[selectedTeam.toLowerCase()] || "";
  const conference = division.split(" ")[0];
  const opponent = row => [upper(row.game.favorite), upper(row.game.underdog)].find(team => team !== selectedTeam) || "";
  const opponentDivision = row => WEBSITE_TEAM_DIVISIONS[opponent(row).toLowerCase()] || "";
  const spread = row => Math.abs(Number(row.game.spread || 0));
  const month = row => Number(String(row.game.gameDate || "").slice(5, 7));
  const weekday = row => {
    const date = new Date(`${row.game.gameDate || ""}T12:00:00`);
    return Number.isNaN(date.getTime()) ? "" : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
  };
  const segments = [
    ["overall", "All games", () => true],
    ["venue", "At home", row => upper(row.game.home) === selectedTeam], ["venue", "On the road", row => upper(row.game.away) === selectedTeam], ["venue", "Neutral sites", row => websiteIsNeutralSite(row.game)],
    ["role", "As the favorite", row => upper(row.game.favorite) === selectedTeam], ["role", "As the underdog", row => upper(row.game.underdog) === selectedTeam],
    ["division", "Division games", row => division && opponentDivision(row) === division], ["conference", `${conference} opponents`, row => conference && opponentDivision(row).startsWith(conference)],
    ["roof", "Indoor games", row => /dome|closed|indoor/i.test(String(row.game.roof || ""))], ["roof", "Outdoor games", row => !/dome|closed|indoor/i.test(String(row.game.roof || ""))],
    ["surface", "Grass fields", row => /grass/i.test(String(row.game.surface || ""))], ["surface", "Artificial turf", row => /turf|astro|artificial/i.test(String(row.game.surface || ""))],
    ["temperature", "Cold games, 40°F or below", row => row.game.temperatureF != null && Number(row.game.temperatureF) <= 40], ["temperature", "Hot games, 80°F or above", row => row.game.temperatureF != null && Number(row.game.temperatureF) >= 80], ["wind", "Windy games, 15+ mph", row => row.game.windMph != null && Number(row.game.windMph) >= 15],
    ["spread", "Tight spreads, 2 points or less", row => spread(row) <= 2], ["spread", "Field-goal spreads, 2.5-3.5", row => spread(row) >= 2.5 && spread(row) <= 3.5], ["spread", "Big spreads, 7 points or more", row => spread(row) >= 7],
    ["kickoff", "1 PM kickoffs", row => { const hour = kickoffHour(row.game.officialGameTime || row.game.gameTime); return hour != null && hour >= 12.5 && hour < 15; }], ["kickoff", "Late-afternoon kickoffs", row => { const hour = kickoffHour(row.game.officialGameTime || row.game.gameTime); return hour != null && hour >= 15 && hour < 19; }], ["kickoff", "Night games", row => { const hour = kickoffHour(row.game.officialGameTime || row.game.gameTime); return hour != null && hour >= 19; }],
    ["weekday", "Monday games", row => weekday(row) === "Monday"], ["weekday", "Thursday games", row => weekday(row) === "Thursday"], ["weekday", "Sunday games", row => weekday(row) === "Sunday"],
    ["spot", "At home on Monday night", row => upper(row.game.home) === selectedTeam && weekday(row) === "Monday" && kickoffHour(row.game.officialGameTime || row.game.gameTime) >= 19],
    ["spot", "Home division games", row => upper(row.game.home) === selectedTeam && division && opponentDivision(row) === division],
    ["spot", "Road division games", row => upper(row.game.away) === selectedTeam && division && opponentDivision(row) === division],
    ["spot", "Home underdog games", row => upper(row.game.home) === selectedTeam && upper(row.game.underdog) === selectedTeam],
    ["spot", "Road favorite games", row => upper(row.game.away) === selectedTeam && upper(row.game.favorite) === selectedTeam],
    ["season", "September games", row => month(row) === 9], ["season", "December and January", row => [12, 1].includes(month(row))], ["season", "Playoff games", row => /round|super bowl|playoffs/i.test(String(row.game.week || "")) || String(row.game.competition || "").toLowerCase() === "playoffs"],
    ["support", "Heavy pool support, 65%+", row => row.support != null && row.support >= .65], ["support", "Low pool support, under 35%", row => row.support != null && row.support < .35]
  ].map(([group, label, test]) => { const selected = rows.filter(test), result = record(selected); return { group, label, selected, result, rate: rate(result) }; });
  const overall = record(rows), overallRate = rate(overall), minimum = Math.min(12, Math.max(5, Math.floor(rows.length * .04)));
  const eligible = segments.filter(segment => segment.group !== "overall" && segment.result.wins + segment.result.losses >= minimum);
  const overlap = (left, right) => {
    const rightRows = new Set(right.selected), shared = left.selected.filter(row => rightRows.has(row)).length;
    return shared / Math.max(1, Math.min(left.selected.length, right.selected.length));
  };
  const choose = (ordered, excluded = []) => {
    const selected = [];
    ordered.forEach(segment => { if (selected.length < 7 && !excluded.includes(segment) && !selected.some(item => item.group === segment.group || overlap(item, segment) >= .7)) selected.push(segment); });
    return selected;
  };
  const best = choose(eligible.filter(segment => segment.rate >= Math.max(.52, overallRate + .005)).sort((left, right) => right.rate - left.rate || right.selected.length - left.selected.length));
  const worst = choose(eligible.filter(segment => segment.rate <= Math.min(.48, overallRate - .005)).sort((left, right) => left.rate - right.rate || right.selected.length - left.selected.length), best);
  const rowsHtml = selected => selected.map(segment => {
    const difference = (segment.rate - overallRate) * 100;
    return `<div class="behavior-row"><div><strong>${websiteEscapeHtml(segment.label)}</strong><small>${segment.selected.length} games · ${difference >= 0 ? "+" : ""}${difference.toFixed(1)} points vs overall</small></div><span>${segment.result.wins}-${segment.result.losses}${segment.result.pushes ? `-${segment.result.pushes}` : ""}<br>${(segment.rate * 100).toFixed(1)}%</span></div>`;
  }).join("");
  const chronological = selected => [...selected].sort((left, right) => String(left.game.gameDate || "").localeCompare(String(right.game.gameDate || "")) || Number(left.game.weekOrder || left.game.week || 0) - Number(right.game.weekOrder || right.game.week || 0) || Number(left.game.gameNum || 0) - Number(right.game.gameNum || 0));
  const latestTeamSeason = chronological(rows).at(-1)?.game.season;
  const streaks = segments.map(segment => {
    const selected = chronological(segment.selected);
    const latest = selected.at(-1), outcome = latest?.win ? "win" : latest?.loss ? "loss" : "";
    let length = 0;
    for (let index = selected.length - 1; index >= 0 && (outcome === "win" ? selected[index].win : selected[index].loss); index--) length += 1;
    return { ...segment, outcome, length, latest };
  }).filter(streak => streak.length >= 3 && streak.latest?.game.season === latestTeamSeason).sort((left, right) => right.length - left.length || right.selected.length - left.selected.length);
  const chooseStreaks = outcome => {
    const chosen = [];
    streaks.filter(streak => streak.outcome === outcome).forEach(streak => {
      if (chosen.length < 3 && !chosen.some(item => item.group === streak.group || overlap(item, streak) >= .8)) chosen.push(streak);
    });
    return chosen;
  };
  const streaksHtml = selected => selected.length ? `<div class="behavior-situation-group"><h5>Active streaks</h5>${selected.map(streak => {
    const checkpoint = `${streak.latest.game.season} ${String(streak.latest.game.week).toLowerCase().includes("round") || String(streak.latest.game.week).toLowerCase().includes("bowl") ? streak.latest.game.week : `Week ${streak.latest.game.week}`}`;
    const result = streak.outcome === "win" ? `Covered ${streak.length} straight` : `Failed to cover ${streak.length} straight`;
    return `<div class="behavior-row"><div><strong>${websiteEscapeHtml(streak.label)}</strong><small>Active through ${websiteEscapeHtml(checkpoint)}</small></div><span>${websiteEscapeHtml(result)}</span></div>`;
  }).join("")}</div>` : "";
  host.innerHTML = `<h3 class="compact-live-title">Where ${websiteEscapeHtml(selectedTeam)} delivers and struggles</h3><p class="analysis-note">Team ATS results across ${rows.length} graded games. The strongest qualified rates and active ATS streaks are balanced across positive and negative panels.</p><div class="behavior-grid"><section class="positive"><h4>▲ Positive stats</h4>${best.length ? rowsHtml(best) : '<p class="analysis-note">No qualified positive splits.</p>'}${streaksHtml(chooseStreaks("win"))}</section><section class="negative"><h4>▼ Negative stats</h4>${worst.length ? rowsHtml(worst) : '<p class="analysis-note">No qualified negative splits.</p>'}${streaksHtml(chooseStreaks("loss"))}</section></div><p class="analysis-note">Rate samples require at least ${minimum} graded team games. Win rate excludes pushes; streaks require at least three consecutive decisions in the named situation.</p>`;
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
  charts.before(selectedSection);
  const sharedControls = panel.querySelector(":scope > .explorer-controls");
  const teamLabel = document.getElementById("teams-team")?.closest("label"), metricLabel = document.getElementById("teams-metric")?.closest("label");
  const selectedControls = document.createElement("div");
  selectedControls.className = "explorer-controls";
  selectedControls.style.marginBottom = "12px";
  metricLabel?.remove();
  if (teamLabel) selectedControls.append(teamLabel);
  selectedSection.querySelector(".teams-section-title").after(selectedControls);
  if (sharedControls && !sharedControls.children.length) sharedControls.remove();
  chartPanels[0]?.remove();
  selectedSection.querySelector("#teams-selected-summary").append(document.getElementById("teams-summary"));
  chartPanels[3]?.remove();
  selectedSection.querySelector("#teams-selected-charts").append(...chartPanels.slice(1, 3));
  const comparisonHeading = headingFor("Team leaderboard"), comparisonHost = document.getElementById("teams-leaderboard-table"), bestBetHeading = headingFor("Best Bet records"), bestBetHost = document.getElementById("teams-bestbet-table");
  if (comparisonHeading && comparisonHost) { comparisonHeading.remove(); globalSection.querySelector("#teams-global-charts").replaceWith(comparisonHost); panel.append(globalSection); }
  bestBetHeading?.remove();
  bestBetHost?.remove();
  const affinityHeading = document.getElementById("teams-affinity-title");
  if (affinityHeading) selectedSection.append(affinityHeading, document.getElementById("teams-affinity-table"));
  charts.remove();
}

function initializeTeamsControls() {
  setupTeamsSections();
  const seasonSelect = document.getElementById("teams-season");
  const teamSelect = document.getElementById("teams-team");
  const priorTeam = teamSelect.value;
  const teamPickerName = team => ({ OAK: "Raiders (Oakland 2009-2019)", STL: "Rams (St. Louis 2009-2015)", SD: "Chargers (San Diego 2009-2016)" }[team] || websiteNaturalTeamName(team));
  if (seasonSelect.options.length === 1) {
    [...new Set(websiteGames.map(game => game.season))].sort().reverse()
      .forEach(season => seasonSelect.add(new Option(season, season)));
  }
  const teams = [...new Set(websiteGames.flatMap(game => [game.favorite, game.underdog])
    .map(value => String(value || "").toUpperCase()).filter(Boolean))].sort((left, right) => teamPickerName(left).localeCompare(teamPickerName(right)) || left.localeCompare(right));
  if (!teamSelect.options.length) teams.forEach(team => teamSelect.add(new Option(team, team)));
  teamSelect.value = priorTeam || (teams.includes("ARI") ? "ARI" : teams[0] || "");
  let picker = teamSelect.parentElement.querySelector(".teams-team-picker");
  if (!picker) {
    picker = document.createElement("details");
    picker.className = "teams-team-picker";
    picker.innerHTML = `<summary aria-label="Choose a team"></summary><div class="teams-team-menu" role="listbox">${teams.map(team => { const logoCode = WEBSITE_TEAM_LOGO_CODES[team.toLowerCase()] || team.toLowerCase(); return `<button class="teams-team-option" type="button" role="option" data-team="${websiteEscapeHtml(team)}" aria-selected="false"><img class="teams-team-logo" src="https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${logoCode}.png" alt="" loading="lazy"><span class="teams-team-name">${websiteEscapeHtml(teamPickerName(team))}</span><span class="teams-team-code">${websiteEscapeHtml(team)}</span></button>`; }).join("")}</div>`;
    picker.querySelector("summary").onclick = event => { event.preventDefault(); event.stopPropagation(); picker.open = !picker.open; };
    picker.querySelectorAll("[role=option]").forEach(option => option.onclick = event => { event.preventDefault(); event.stopPropagation(); teamSelect.value = option.dataset.team; teamSelect.dispatchEvent(new Event("change", { bubbles: true })); picker.open = false; });
    teamSelect.after(picker);
  }
  const selectedTeam = teamSelect.value;
  const selectedLogoCode = WEBSITE_TEAM_LOGO_CODES[selectedTeam.toLowerCase()] || selectedTeam.toLowerCase();
  picker.querySelector("summary").innerHTML = `<img class="teams-team-logo" src="https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${selectedLogoCode}.png" alt=""><span class="teams-team-name">${websiteEscapeHtml(teamPickerName(selectedTeam))}</span><span class="teams-team-code">${websiteEscapeHtml(selectedTeam)}</span>`;
  picker.querySelectorAll("[role=option]").forEach(option => option.setAttribute("aria-selected", String(option.dataset.team === selectedTeam)));
  if (!picker.dataset.clickAwayReady) {
    document.addEventListener("click", event => { if (!picker.contains(event.target)) picker.open = false; });
    picker.dataset.clickAwayReady = "true";
  }
  [seasonSelect, teamSelect, document.getElementById("teams-metric")]
    .filter(Boolean).forEach(select => select.onchange = renderTeams);
}

function renderTeams() {
  if (!websiteGames.length || !websitePicks.length) return;
  initializeTeamsControls();
  const season = document.getElementById("teams-season").value;
  const selectedTeam = document.getElementById("teams-team").value;
  const rows = teamRowsForSeason(season);
  const selected = rows.find(row => row.team === selectedTeam) || emptyTeamStat(selectedTeam, season);
  const pct = value => `${(value * 100).toFixed(1)}%`;
  const record = (wins, losses, pushes) => `${wins}-${losses}${pushes ? `-${pushes}` : ""}`;

  document.getElementById("teams-summary").innerHTML = [
    ["Wins ATS", selected.covers || 0],
    ["Losses ATS", selected.noCovers || 0],
    ["ATS win %", pct(selected.coverRate || 0)],
    ["Times picked", selected.picks || 0],
    ["Times picked against", selected.fades || 0],
    ["Times Best Bet", selected.bestBets || 0],
    ["Times BB against", selected.bestBetsAgainst || 0]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  document.getElementById("teams-selected-title").textContent = `${selectedTeam} Team Detail`;
  renderTeamBehavior(selectedTeam, season);

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
      { label: `${selectedTeam} ATS cover rate`, data: trend.map(row => row.games ? Number((row.coverRate * 100).toFixed(1)) : null), borderColor: "#39c982", backgroundColor: "#39c982", borderWidth: 3, tension: .2 },
      { label: "50% break-even", data: seasons.map(() => 50), borderColor: "#91a0ae", backgroundColor: "#91a0ae", borderDash: [5, 5], pointRadius: 0, borderWidth: 1 }
    ] },
    options: { responsive: true, maintainAspectRatio: false, layout: { padding: { right: 70 } }, interaction: { mode: "index", intersect: false }, scales: { x: { ticks: { color: "#91a0ae", maxRotation: 60, minRotation: 45 }, grid: { color: "#2a3744" } }, y: { beginAtZero: true, max: 100, ticks: { color: "#91a0ae", callback: value => value + "%" }, grid: { color: context => context.tick.value === 50 ? "#b8c4cf" : "#2a3744", lineWidth: context => context.tick.value === 50 ? 2 : 1 } } }, plugins: { legend: { labels: { color: "#e8eef5", filter: item => item.text !== "50% break-even" } }, tooltip: { filter: item => item.dataset.label !== "50% break-even", callbacks: { afterBody: items => { const row = trend[items[0].dataIndex]; return [`Average support: ${pct(row.supportRate)} across ${row.supportGames} games`, `Team ATS: ${record(row.covers, row.noCovers, row.gamePushes)} (${pct(row.coverRate)})`]; } } } } },
    plugins: [teamsTrendGuides]
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
    row.wins += win; row.losses += loss; row.pushes += push; row.meetings.push({ game, win, loss, push });
    opponentStats.set(opponent, row);
  });
  const allOpponents = [...opponentStats.values()].map(row => ({ ...row, rate: teamRate(row.wins, row.losses) }));
  const matchupHead = document.getElementById("teams-consensus-title").closest(".panel-head");
  if (!document.getElementById("teams-matchup-mode")) matchupHead.insertAdjacentHTML("beforeend", '<label>View<select id="teams-matchup-mode" aria-label="Best or worst ATS matchups"><option value="best">Best ATS Matchups</option><option value="worst">Worst ATS Matchups</option></select></label><label>Opponent<select id="teams-matchup-opponent" aria-label="Matchup opponent"><option value="all">All opponents</option></select></label>');
  const matchupMode = document.getElementById("teams-matchup-mode"), opponentSelect = document.getElementById("teams-matchup-opponent"), priorOpponent = opponentSelect.value;
  const opponentName = team => websiteNaturalTeamName(String(team || "").toLowerCase());
  opponentSelect.innerHTML = '<option value="all">All opponents</option>' + [...allOpponents].sort((left, right) => opponentName(left.opponent).localeCompare(opponentName(right.opponent))).map(row => `<option value="${websiteEscapeHtml(row.opponent)}">${websiteEscapeHtml(opponentName(row.opponent))}</option>`).join("");
  opponentSelect.value = allOpponents.some(row => row.opponent === priorOpponent) ? priorOpponent : "all";
  const mode = matchupMode.value, chosenOpponent = opponentSelect.value;
  const repeatOpponents = allOpponents.filter(row => row.meetings.length >= 3), matchupPool = chosenOpponent === "all" ? (repeatOpponents.length ? repeatOpponents : allOpponents) : allOpponents.filter(row => row.opponent === chosenOpponent);
  const opponents = [...matchupPool].sort((left, right) => (mode === "worst" ? left.rate - right.rate : right.rate - left.rate) || right.meetings.length - left.meetings.length || left.opponent.localeCompare(right.opponent)).slice(0, 10);
  matchupMode.onchange = renderTeams;
  opponentSelect.onchange = renderTeams;
  document.getElementById("teams-consensus-title").textContent = `${selectedTeam}: ${mode === "worst" ? "Worst" : "Best"} ATS Matchups`;
  document.getElementById("teams-consensus-note").textContent = opponents.length ? chosenOpponent === "all" ? `Specific opponents with at least three archived meetings, ordered from ${mode === "worst" ? "lowest to highest" : "highest to lowest"} cover rate. Choose an opponent to isolate its complete matchup history.` : `${selectedTeam}'s complete graded ATS history against ${opponentName(chosenOpponent)} in the selected seasons.` : `No graded matchup history is available for ${selectedTeam} in the selected seasons.`;
  if (teamsConsensusChart) teamsConsensusChart.destroy();
  document.getElementById("teams-consensus-chart").parentElement.style.height = `${Math.max(335, opponents.length * 30 + 70)}px`;
  teamsConsensusChart = new Chart(document.getElementById("teams-consensus-chart"), {
    type: "bar",
    data: { labels: opponents.map(() => ""), datasets: [{ label: "ATS cover %", data: opponents.map(row => Number((row.rate * 100).toFixed(1))), barText: opponents.map(row => [`${selectedTeam} vs ${row.opponent}`, `${(row.rate * 100).toFixed(1)}% · ${record(row.wins, row.losses, row.pushes)}`]), forceInside: true, backgroundColor: opponents.map(row => row.rate >= .5 ? "#39c98299" : "#ff6b6b99"), borderColor: opponents.map(row => row.rate >= .5 ? "#39c982" : "#ff6b6b"), borderWidth: 1 }] },
    plugins: [teamsBarValueLabels],
    options: { indexAxis: "y", responsive: true, maintainAspectRatio: false, scales: { x: { beginAtZero: true, max: 100, ticks: { color: "#91a0ae", callback: value => value + "%" }, grid: { color: context => context.tick.value === 50 ? "#b8c4cf" : "#2a3744", lineWidth: context => context.tick.value === 50 ? 2 : 1 } }, y: { ticks: { display: false }, grid: { display: false } } }, plugins: { legend: { display: false }, tooltip: { enabled: false, external: context => profileChartTooltip(context, index => { const row = opponents[index]; return `<strong>${websiteEscapeHtml(`${selectedTeam} vs ${row.opponent} · ${record(row.wins, row.losses, row.pushes)} · ${pct(row.rate)}`)}</strong>${[...row.meetings].sort((left, right) => String(right.game.gameDate || "").localeCompare(String(left.game.gameDate || ""))).map(meeting => `<div>${weeklyGameTooltipHtml(meeting.game, meeting.win ? "win" : meeting.loss ? "loss" : "push", selectedTeam)}</div>`).join("")}`; }, true) } } }
  });

  const tableRows = [...rows].sort((left, right) => right.picks - left.picks).map(row => ({
    team: row.team, picks: row.picks, record: record(row.wins, row.losses, row.pushes), pickPct: row.pickRate,
    fades: row.fades, fadeRecord: record(row.fadeWins, row.fadeLosses, row.fadePushes), fadePct: row.fadeRate,
    bestBets: row.bestBets, bestBetRecord: record(row.bestBetWins, row.bestBetLosses, row.bestBetPushes), bestBetPct: row.bestBetRate
  }));
  renderSortableTeamsSheet(document.getElementById("teams-leaderboard-table"), tableRows, [
    { key: "team", label: "Team", value: row => row.team }, { key: "picks", label: "Picked", value: row => row.picks }, { key: "pickPct", label: "Pick ATS", value: row => row.pickPct, html: row => teamsRateCell(row.pickPct, `${row.record} · ${pct(row.pickPct)}`) },
    { key: "fades", label: "Against", value: row => row.fades }, { key: "fadePct", label: "Against ATS", value: row => row.fadePct, html: row => teamsRateCell(row.fadePct, `${row.fadeRecord} · ${pct(row.fadePct)}`) },
    { key: "bestBets", label: "Best Bets", value: row => row.bestBets }, { key: "bestBetPct", label: "BB ATS", value: row => row.bestBetPct, html: row => teamsRateCell(row.bestBetPct, `${row.bestBetRecord} · ${pct(row.bestBetPct)}`) }
  ], "picks");

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
  renderSortableTeamsSheet(document.getElementById("teams-affinity-table"), affinityRows, [
    { key: "player", label: "Player", value: row => row.player }, { key: "picks", label: "Picked", value: row => row.picks }, { key: "affinityPct", label: "Pick share", value: row => row.affinityPct, html: row => teamsRateCell(row.affinityPct, pct(row.affinityPct)) },
    { key: "winPct", label: "Pick ATS", value: row => row.winPct, html: row => teamsRateCell(row.winPct, `${row.record} · ${pct(row.winPct)}`) }, { key: "bestBets", label: "Best Bets", value: row => row.bestBets }, { key: "bestBetPct", label: "BB ATS", value: row => row.bestBetPct, html: row => teamsRateCell(row.bestBetPct, `${row.bestBetRecord} · ${pct(row.bestBetPct)}`) },
    { key: "against", label: "Against", value: row => row.against }, { key: "againstPct", label: "Against ATS", value: row => row.againstPct, html: row => teamsRateCell(row.againstPct, `${row.againstRecord} · ${pct(row.againstPct)}`) }
  ], "picks");
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
