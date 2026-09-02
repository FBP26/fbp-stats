const historicalTooltipStandards = {
  id: "historicalTooltipStandards",
  beforeInit(chart) {
    const id = chart.canvas.id;
    if (id === "alltime-top-chart" || id === "alltime-season-weeks-chart") {
      chart.options.plugins.tooltip ||= {};
      chart.options.plugins.tooltip.enabled = false;
      chart.options.plugins.tooltip.external = context => profileChartTooltip(context, index => {
        if (id === "alltime-top-chart") return historicalSeasonSummaryHtml(chart.data.labels[index]);
        const season = chart.data.labels[index], name = chart.data.datasets[0].barText?.[index]?.name;
        return historicalSeasonSummaryHtml(name, season);
      });
    }
    if (id === "alltime-plus-minus-trend-chart") {
      chart.options.plugins.tooltip ||= {};
      chart.options.plugins.tooltip.callbacks = {
        title: items => items[0]?.label || "",
        label: context => `${context.dataset.label}: ${Number(context.raw) > 0 ? "+" : ""}${context.raw} cumulative`
      };
    }
    if (id === "alltime-turnout-chart") {
      chart.options.plugins.tooltip ||= {};
      chart.options.plugins.tooltip.callbacks = {
        title: items => items[0]?.label || "",
        label: context => `${context.raw} players entered`
      };
    }
  },
  beforeDatasetsDraw(chart) {
    if (chart.canvas.id !== "season-contrarian-chart" || !chart.chartArea) return;
    const points = chart.data.datasets.flatMap(dataset => dataset.data || []).filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
    if (!points.length) return;
    const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
    const x = chart.scales.x.getPixelForValue(median(points.map(point => point.x)));
    const y = chart.scales.y.getPixelForValue(median(points.map(point => point.y)));
    const { ctx, chartArea } = chart;
    const zones = [
      [chartArea.left, chartArea.top, x - chartArea.left, y - chartArea.top, "rgba(84, 214, 178, .035)"],
      [x, chartArea.top, chartArea.right - x, y - chartArea.top, "rgba(84, 214, 178, .09)"],
      [chartArea.left, y, x - chartArea.left, chartArea.bottom - y, "rgba(255, 180, 84, .035)"],
      [x, y, chartArea.right - x, chartArea.bottom - y, "rgba(255, 180, 84, .075)"]
    ];
    ctx.save();
    zones.forEach(([left, top, width, height, color]) => { ctx.fillStyle = color; ctx.fillRect(left, top, width, height); });
    ctx.fillStyle = "#91a0ae";
    ctx.font = "10px Georgia";
    ctx.textAlign = "right";
    ctx.fillText("effective contrarians", chartArea.right - 6, chartArea.top + 13);
    ctx.fillText("high-risk contrarians", chartArea.right - 6, chartArea.bottom - 7);
    ctx.restore();
  },
  afterDraw(chart) {
    if (chart.canvas.id === "season-race-chart" && chart.chartArea) {
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.font = "bold 11px Georgia";
      ctx.textAlign = "right";
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const meta = chart.getDatasetMeta(datasetIndex);
        const point = meta.data.at(-1);
        const gap = Number(dataset.data.at(-1));
        if (!point || !Number.isFinite(gap)) return;
        ctx.fillStyle = dataset.borderColor;
        ctx.fillText(gap === 0 ? "LEADER" : `${gap.toFixed(1)}`, chartArea.right - 6, Math.max(chartArea.top + 12, point.y - 7));
      });
      ctx.restore();
      return;
    }
    if (chart.canvas.id !== "season-consistency-chart" || !chart.chartArea) return;
    const points = chart.data.datasets.flatMap(dataset => dataset.data || []).filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
    if (!points.length) return;
    const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
    const x = chart.scales.x.getPixelForValue(median(points.map(point => point.x)));
    const y = chart.scales.y.getPixelForValue(median(points.map(point => point.y)));
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = "#52606d";
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#91a0ae";
    ctx.font = "10px Georgia";
    ctx.textAlign = "left";
    ctx.fillText("volatile, lower average", chartArea.left + 6, chartArea.top + 13);
    ctx.textAlign = "right";
    ctx.fillText("high ceiling", chartArea.right - 6, chartArea.top + 13);
    ctx.fillText("steady contenders", chartArea.right - 6, chartArea.bottom - 7);
    ctx.restore();
  }
};
Chart.register(historicalTooltipStandards);

function historicalSeasonSummaryHtml(name, season = "") {
  const rows = websiteWeeks.filter(row => row.competition === "regular" && (!name || row.name === name) && (!season || row.season === season));
  const groups = rows.reduce((map, row) => { const list = map.get(row.season) || []; list.push(row); map.set(row.season, list); return map; }, new Map());
  const finishClass = rank => Number(rank) === 1 ? "top1" : Number(rank) <= 5 ? "top5" : Number(rank) <= 10 ? "top10" : "other";
  const summaries = [...groups].sort(([left], [right]) => String(right).localeCompare(String(left))).map(([seasonId, weeks]) => {
    const wins = weeks.reduce((sum, row) => sum + Number(row.displayWins || 0), 0), losses = weeks.reduce((sum, row) => sum + Number(row.displayLosses || 0), 0), pushes = weeks.reduce((sum, row) => sum + Number(row.displayPushes || 0), 0);
    const rank = weeks.find(row => row.seasonRank != null)?.seasonRank, weeksWon = weeks.reduce((sum, row) => sum + Number(row.winShare ?? (Number(row.rank) === 1 ? 1 : 0)), 0), money = weeks.reduce((sum, row) => sum + Number(row.moneyAward || 0), 0), bestRank = Math.min(...weeks.map(row => Number(row.rank) || Infinity)), rate = wins + losses ? wins / (wins + losses) * 100 : 0;
    return { seasonId, weeks, wins, losses, pushes, rank, weeksWon, money, bestRank, rate };
  });
  if (!summaries.length) return `<strong>${websiteEscapeHtml(name || "Season summary")}</strong><div><span class="neutral">No season details recorded</span></div>`;
  const totalWins = summaries.reduce((sum, row) => sum + row.wins, 0), totalLosses = summaries.reduce((sum, row) => sum + row.losses, 0), totalMoney = summaries.reduce((sum, row) => sum + row.money, 0), totalWeeksWon = summaries.reduce((sum, row) => sum + row.weeksWon, 0);
  if (!season) {
    const body = summaries.map(row => `<div class="season-tooltip-row ${finishClass(row.rank)}"><span>${websiteEscapeHtml(row.seasonId)}</span><span class="rank">${row.rank ? `#${row.rank}` : "-"}</span><span>${row.wins}-${row.losses}${row.pushes ? `-${row.pushes}` : ""}</span><span>${row.rate.toFixed(1)}%</span><span>${Number(row.weeksWon.toFixed(2)) || "-"}</span><span class="money">${row.money ? `$${row.money.toLocaleString()}` : "-"}</span></div>`).join("");
    return `<div class="season-long-tooltip"><strong>${websiteEscapeHtml(name || "Season summary")} · season by season</strong><div class="season-tooltip-head"><span>Season</span><span>Rank</span><span>Record</span><span>Win %</span><span>Wins</span><span>Money</span></div>${body}<div class="season-tooltip-summary"><span><strong>${summaries.length}</strong> seasons</span><span><strong>${totalWins}-${totalLosses}</strong> career record</span><span><strong>${Number(totalWeeksWon.toFixed(2))}</strong> weeks won</span><span><strong>$${totalMoney.toLocaleString()}</strong> earned</span></div></div>`;
  }
  const row = summaries[0], weekly = row.weeks.sort((left, right) => Number(left.weekOrder || left.week) - Number(right.weekOrder || right.week)).map(week => `<div class="tooltip-week-row ${finishClass(week.rank)}" data-weekly-drilldown data-player-id="${websiteEscapeHtml(week.playerId)}" data-season="${websiteEscapeHtml(week.season)}" data-week="${websiteEscapeHtml(week.week)}"><span>${profileWeekLabel(week.week)}</span><span>#${week.rank || "-"}</span><span>${week.displayWins}-${week.displayLosses}${Number(week.displayPushes || 0) ? `-${week.displayPushes}` : ""}</span></div>`).join("");
  return `<div class="season-long-tooltip"><strong>${websiteEscapeHtml(name || "Season summary")} · ${websiteEscapeHtml(season)}</strong><div class="season-tooltip-summary"><span><strong>#${row.rank || "-"}</strong> season finish</span><span><strong>${row.wins}-${row.losses}${row.pushes ? `-${row.pushes}` : ""}</strong> record</span><span><strong>${row.rate.toFixed(1)}%</strong> win rate</span><span><strong>${Number(row.weeksWon.toFixed(2))}</strong> weeks won</span><span><strong>#${Number.isFinite(row.bestRank) ? row.bestRank : "-"}</strong> best week</span><span><strong>${row.money ? `$${row.money.toLocaleString()}` : "$0"}</strong> earned</span></div>${weekly}</div>`;
}

function setupAllTimeHoverTargets() {
  document.querySelectorAll("#alltime-champions tbody tr").forEach(row => {
    const season = row.cells[0]?.textContent.trim(), fieldCell = row.cells[row.cells.length - 1];
    row.removeAttribute("data-weekly-tooltip");
    [row.cells[0], row.cells[1], row.cells[4]].forEach(cell => { cell?.removeAttribute("title"); cell?.removeAttribute("data-weekly-tooltip"); });
    if (!season || !fieldCell) return;
    const players = [...new Map(websiteWeeks.filter(item => item.season === season && item.competition === "regular" && item.seasonRank != null).map(item => [item.playerId, item])).values()].sort((left, right) => Number(left.seasonRank) - Number(right.seasonRank) || left.name.localeCompare(right.name));
    fieldCell.dataset.weeklyTooltip = `<strong>${websiteEscapeHtml(season)} · ${players.length} players</strong>${players.map(player => `<div>#${websiteEscapeHtml(player.seasonRank)} · ${websiteEscapeHtml(player.name)}</div>`).join("")}`;
  });
  const seasons = websiteSeasons.map(item => item.seasonId);
  document.querySelectorAll("#alltime-seasons-grid tbody tr").forEach(row => {
    const name = row.cells[0]?.textContent.trim();
    seasons.forEach((season, index) => {
      const cell = row.cells[index + 1];
      if (name && cell?.textContent.trim()) cell.dataset.weeklyTooltip = historicalSeasonSummaryHtml(name, season);
    });
  });
}

function setupProfileSidebarHovers() {
  const host = document.getElementById("profile-extra-stats");
  const main = document.getElementById("profile-stats");
  if (!host || !main) return;
  const definitions = {
    "Wins": "Career correct picks against the spread.", "Losses": "Career missed picks against the spread.", "Weeks": "Regular and playoff weeks entered.", "Win %": "Career wins divided by career decisions.", "Plus/minus": "Career wins minus career losses.", "Weeks won": "Weekly first-place finishes, with ties split evenly.",
    "Total money won": "Weekly, playoff, and season prize money combined.", "Weekly money": "Prize money from regular weekly wins.", "Playoff money": "Prize money from playoff championships.", "Season money": "Prize money from regular-season championships.",
    "Top 5 finishes": "Weeks finished fifth or better.", "Top 10 finishes": "Weeks finished tenth or better.", "800 club": "Weeks with an 80% or better pick rate.", "700 club": "Weeks from 70% through 79.9%."
  };
  [...main.querySelectorAll(":scope > div"), ...host.querySelectorAll(".profile-list > div")].forEach(row => {
    const label = row.querySelector("span")?.textContent.trim(), value = row.querySelector("strong")?.textContent.trim();
    if (!label || row.dataset.weeklyTooltip) return;
    row.dataset.weeklyTooltip = `<strong>${websiteEscapeHtml(label)} · ${websiteEscapeHtml(value || "0")}</strong><div><span class="neutral">${websiteEscapeHtml(definitions[label] || `Current ${label.toLowerCase()} for the selected player.`)}</span></div>`;
  });
  const streakSection = [...host.querySelectorAll(".profile-section")].find(section => section.querySelector("h3")?.textContent === "Streak details");
  const labelKeys = { "Correct picks": "win_streak", "Wrong picks": "losing_streak", "Best bet hit": "best_bet_hit_streak", "Best bet miss": "best_bet_miss_streak", "Best team run": "best_team_pick_streak", "Worst team run": "worst_team_pick_streak", "Top 5 streak": "top5_streak", "Top 10 streak": "top10_streak", "Weeks without a win": "no_first_streak" };
  streakSection?.querySelectorAll(".profile-list > div").forEach(row => {
    const label = row.querySelector("span")?.textContent.trim(), key = labelKeys[label], category = STREAK_CATEGORIES.find(item => item.key === key), name = document.getElementById("profile-player")?.value;
    if (!key || !category || !name) return;
    const canonical = (tableData[key] || []).find(item => item.Name === name), parsed = splitStreakLabel(canonical?.[category.column]);
    row.dataset.weeklyTooltip = streakCardsTooltipHtml({ name, length: Number(parsed.count) || Number(row.querySelector("strong")?.textContent) || 0, span: parsed.detail, detail: String(canonical?.[category.detail] || "") }, category);
  });
}

function setupProfileCareerTrends() {
  const historyCanvas = document.getElementById("profile-history-chart");
  const moneyCanvas = document.getElementById("profile-money-chart");
  const plusCanvas = document.getElementById("profile-plus-minus-chart");
  const finishCanvas = document.getElementById("profile-finish-chart");
  const stack = document.querySelector("#view-players .profile-chart-stack");
  if (!historyCanvas || !moneyCanvas || !plusCanvas || !finishCanvas || !stack || document.getElementById("profile-career-trends")) return;
  const sourcePanels = [historyCanvas, moneyCanvas].map(canvas => canvas.closest(".panel"));
  const wraps = [historyCanvas, moneyCanvas].map(canvas => canvas.closest(".chart-wrap"));
  const plusPanel = plusCanvas.closest(".panel");
  plusPanel.querySelector("h3").textContent = "Plus/Minus History";
  plusPanel.classList.add("profile-plus-minus-panel");
  finishCanvas.closest(".panel").before(plusPanel);
  const panel = document.createElement("div");
  panel.id = "profile-career-trends";
  panel.className = "panel profile-chart";
  panel.innerHTML = '<div class="panel-head"><h3>Career Trends</h3><label>Metric<select id="profile-career-metric"><option value="profile-history-chart">Wins and money by season</option><option value="profile-money-chart">Cumulative Money</option></select></label></div><div id="profile-career-trend-host"></div>';
  stack.insertBefore(panel, sourcePanels[0]);
  const host = panel.querySelector("#profile-career-trend-host");
  wraps.forEach((wrap, index) => { wrap.hidden = index !== 0; host.appendChild(wrap); });
  sourcePanels.forEach(source => source.remove());
  document.getElementById("profile-career-metric").onchange = event => {
    wraps.forEach(wrap => wrap.hidden = wrap.querySelector("canvas").id !== event.target.value);
    Chart.getChart(event.target.value)?.resize();
  };
}

function setupAllTimeCareerLeaders() {
  const top = document.getElementById("alltime-top-chart")?.closest(".chart-wrap");
  if (!top || document.getElementById("alltime-career-heading")) return;
  const heading = document.createElement("h3");
  heading.id = "alltime-career-heading";
  heading.style.cssText = "margin:28px 0 8px;color:var(--accent);font:11px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase";
  heading.textContent = "Career leaders";
  top.before(heading);
}

function setupAllTimePlusMinusViews() {
  const leaders = document.getElementById("alltime-plus-minus-chart")?.closest(".chart-wrap");
  const history = document.getElementById("alltime-plus-minus-trend-chart")?.closest(".chart-wrap");
  if (!leaders || !history) return;
  document.getElementById("alltime-plus-minus-view-controls")?.remove();
  leaders.hidden = false;
  history.hidden = true;
  const historyHeading = document.getElementById("alltime-plus-minus-trend-heading");
  const historyControls = document.getElementById("alltime-plus-minus-trend-controls");
  if (historyHeading) historyHeading.hidden = true;
  if (historyControls) historyControls.hidden = true;
  requestAnimationFrame(() => Chart.getChart("alltime-plus-minus-chart")?.resize());
}

function setupSeasonCombinedViews() {
  const consistency = document.getElementById("season-consistency-chart")?.closest(".chart-wrap");
  const contrarian = document.getElementById("season-contrarian-chart")?.closest(".chart-wrap");
  if (consistency && contrarian && !document.getElementById("season-player-style-view")) {
    const consistencyHeading = consistency.previousElementSibling;
    const contrarianHeading = contrarian.previousElementSibling;
    if (consistencyHeading?.tagName === "H3") consistencyHeading.textContent = "Player style";
    if (contrarianHeading?.tagName === "H3") contrarianHeading.hidden = true;
    const controls = document.createElement("div");
    controls.className = "explorer-controls";
    controls.style.cssText = "grid-template-columns:minmax(190px,280px);margin:0 0 12px";
    controls.innerHTML = '<label>View<select id="season-player-style-view"><option value="consistency">Consistency</option><option value="contrarian">Contrarian index</option></select></label>';
    consistency.before(controls);
    consistency.after(contrarian);
    contrarian.hidden = true;
    document.getElementById("season-player-style-view").onchange = event => {
      consistency.hidden = event.target.value !== "consistency";
      contrarian.hidden = event.target.value !== "contrarian";
      requestAnimationFrame(() => Chart.getChart(event.target.value === "contrarian" ? "season-contrarian-chart" : "season-consistency-chart")?.resize());
    };
  }
  const bestBetChart = document.getElementById("season-bb-chart")?.closest(".chart-wrap");
  const bestBetTable = document.getElementById("season-bb-grid");
  if (bestBetChart && bestBetTable && !document.getElementById("season-best-bet-view")) {
    const chartHeading = bestBetChart.previousElementSibling;
    const tableHeading = bestBetTable.previousElementSibling;
    if (chartHeading?.tagName === "H3") chartHeading.textContent = "Best bet accuracy";
    if (tableHeading?.tagName === "H3") tableHeading.remove();
    const controls = document.createElement("div");
    controls.className = "explorer-controls";
    controls.style.cssText = "grid-template-columns:minmax(190px,280px);margin:0 0 12px";
    controls.innerHTML = '<label>View<select id="season-best-bet-view"><option value="table">Weekly results</option><option value="chart">Chart</option></select></label>';
    bestBetChart.before(controls);
    bestBetChart.after(bestBetTable);
    bestBetChart.hidden = true;
    bestBetTable.hidden = false;
    document.getElementById("season-best-bet-view").onchange = event => {
      bestBetChart.hidden = event.target.value !== "chart";
      bestBetTable.hidden = event.target.value !== "table";
      if (event.target.value === "chart") requestAnimationFrame(() => Chart.getChart("season-bb-chart")?.resize());
    };
  }
}

function setupProfileBestWeeksViews() {
  const chart = document.getElementById("profile-best-weeks-chart")?.closest(".chart-wrap");
  const table = document.getElementById("profile-weekly-wins-detail");
  const chartPanel = chart?.closest(".panel"), tablePanel = table?.closest(".panel");
  if (!chart || !table || !chartPanel || !tablePanel || tablePanel.dataset.positioned === "true") return;
  const careerTrends = document.getElementById("profile-career-trends");
  const summary = document.createElement("div");
  summary.id = "profile-weekly-wins-summary";
  summary.className = "summary compact-win-summary";
  table.before(summary);
  if (careerTrends) careerTrends.before(tablePanel);
  tablePanel.dataset.positioned = "true";
}

function setupAttendanceFilter() {
  const canvas = document.getElementById("alltime-attendance-chart");
  const wrap = canvas?.closest(".chart-wrap");
  if (!wrap || document.getElementById("attendance-min-games")) return;
  const controls = document.createElement("div");
  controls.className = "explorer-controls";
  controls.style.cssText = "grid-template-columns:minmax(190px,280px);margin:12px 0";
  controls.innerHTML = '<label>Minimum games<select id="attendance-min-games"><option value="0">All players</option><option value="100" selected>100+ games</option><option value="250">250+ games</option><option value="500">500+ games</option></select></label>';
  wrap.before(controls);
  const applyFilter = () => {
    const chart = Chart.getChart("alltime-attendance-chart");
    if (!chart) return;
    chart.$fullAttendanceData ||= {
      labels: [...chart.data.labels],
      datasets: chart.data.datasets.map(dataset => [...dataset.data])
    };
    const minimum = Number(document.getElementById("attendance-min-games").value);
    const eligiblePlayers = new Set(chart.$fullAttendanceData.datasets.flatMap(dataset => dataset)
      .filter(point => Number(point?.player?.games || 0) >= minimum)
      .map(point => point.y));
    chart.data.labels = chart.$fullAttendanceData.labels.filter(label => eligiblePlayers.has(label));
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      dataset.data = chart.$fullAttendanceData.datasets[datasetIndex].filter(point => eligiblePlayers.has(point.y));
    });
    const height = Math.max(260, chart.data.labels.length * 24 + 90);
    wrap.style.height = `${height}px`;
    canvas.closest(".attendance-chart-inner").style.height = `${height}px`;
    chart.resize();
    chart.update("none");
  };
  document.getElementById("attendance-min-games").onchange = applyFilter;
  applyFilter();
}

const paginatedTableSizes = {
  "season-table": 25,
  "week-table": 50,
  "game-picks-table": 50
};

function setupTableShowAllControls() {
  Object.entries(paginatedTableSizes).forEach(([hostId, pageSize]) => {
    const host = document.getElementById(hostId);
    if (!host) return;
    const currentTable = () => globalThis.Tabulator?.findTable?.(`#${hostId}`)?.[0];
    const table = currentTable();
    if (!table) return;
    let button = document.getElementById(`${hostId}-show-all`);
    if (!button) {
      button = document.createElement("button");
      button.id = `${hostId}-show-all`;
      button.className = "table-show-all";
      button.dataset.showingAll = "false";
      host.before(button);
    }
    const update = () => {
      const activeTable = currentTable();
      if (!activeTable) return;
      const total = activeTable.getDataCount("active");
      const showingAll = button.dataset.showingAll === "true";
      const alreadyAll = total <= pageSize;
      if (button.hidden) button.hidden = false;
      if (button.disabled !== alreadyAll) button.disabled = alreadyAll;
      const label = alreadyAll ? `All ${total} shown` : showingAll ? `Show ${pageSize} per page` : `Show all (${total})`;
      if (button.textContent !== label) button.textContent = label;
    };
    button.onclick = () => {
      const activeTable = currentTable();
      if (!activeTable) return;
      const showingAll = button.dataset.showingAll !== "true";
      button.dataset.showingAll = String(showingAll);
      activeTable.setPageSize(showingAll ? Math.max(1, activeTable.getDataCount("active")) : pageSize);
      activeTable.setPage(1);
      update();
    };
    update();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = '.teams-section-title{margin:28px 0 12px;color:var(--accent);font:11px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase}.table-show-all{margin:8px 0;padding:7px 11px;border:1px solid var(--border);border-radius:4px;background:var(--panel-2);color:var(--text);font:11px Arial,sans-serif;cursor:pointer}.table-show-all:hover{border-color:var(--accent);color:var(--accent)}.table-show-all:disabled{cursor:default;color:var(--muted);opacity:.75}';
  document.head.append(style);
  setupProfileCareerTrends();
  setupProfileBestWeeksViews();
  setupAllTimeCareerLeaders();
  setupAllTimePlusMinusViews();
  setupSeasonCombinedViews();
  setupAttendanceFilter();
  setupTableShowAllControls();
  setupAllTimeHoverTargets();
  setupProfileSidebarHovers();
  const allTimeView = document.getElementById("view-alltime");
  if (allTimeView) new MutationObserver(() => { setupAttendanceFilter(); setupAllTimePlusMinusViews(); }).observe(allTimeView, { childList: true, subtree: true });
  new MutationObserver(() => { setupSeasonCombinedViews(); setupTableShowAllControls(); setupAllTimeHoverTargets(); setupProfileSidebarHovers(); }).observe(document.body, { childList: true, subtree: true });
});
