const historicalTooltipStandards = {
  id: "historicalTooltipStandards",
  beforeInit(chart) {
    const id = chart.canvas.id;
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

function setupProfileCareerTrends() {
  const historyCanvas = document.getElementById("profile-history-chart");
  const moneyCanvas = document.getElementById("profile-money-chart");
  const plusCanvas = document.getElementById("profile-plus-minus-chart");
  const stack = document.querySelector("#view-players .profile-chart-stack");
  if (!historyCanvas || !moneyCanvas || !plusCanvas || !stack || document.getElementById("profile-career-trends")) return;
  const sourcePanels = [historyCanvas, moneyCanvas, plusCanvas].map(canvas => canvas.closest(".panel"));
  const wraps = [historyCanvas, moneyCanvas, plusCanvas].map(canvas => canvas.closest(".chart-wrap"));
  const panel = document.createElement("div");
  panel.id = "profile-career-trends";
  panel.className = "panel profile-chart";
  panel.innerHTML = '<div class="panel-head"><h3>Career Trends</h3><label>Metric<select id="profile-career-metric"><option value="profile-history-chart">Wins and money by season</option><option value="profile-money-chart">Cumulative Money</option><option value="profile-plus-minus-chart">Plus/Minus History</option></select></label></div><div id="profile-career-trend-host"></div>';
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
  const plus = document.getElementById("alltime-plus-minus-chart")?.closest(".chart-wrap");
  if (!top || !plus || document.getElementById("alltime-career-metric")) return;
  const heading = plus.previousElementSibling;
  if (heading?.tagName === "H3") heading.hidden = true;
  const controls = document.createElement("div");
  controls.className = "explorer-controls";
  controls.style.cssText = "grid-template-columns:minmax(220px,320px);margin:18px 0 12px";
  controls.innerHTML = '<label>Career leaders<select id="alltime-career-metric"><option value="alltime-top-chart">Win percentage</option><option value="alltime-plus-minus-chart">Plus/Minus</option></select></label>';
  top.before(controls);
  plus.hidden = true;
  document.getElementById("alltime-career-metric").onchange = event => {
    top.hidden = event.target.value !== "alltime-top-chart";
    plus.hidden = event.target.value !== "alltime-plus-minus-chart";
    Chart.getChart(event.target.value)?.resize();
  };
}

function setupAttendanceFilter() {
  const canvas = document.getElementById("alltime-attendance-chart");
  const wrap = canvas?.closest(".chart-wrap");
  if (!wrap || document.getElementById("attendance-min-games")) return;
  const controls = document.createElement("div");
  controls.className = "explorer-controls";
  controls.style.cssText = "grid-template-columns:minmax(190px,280px);margin:12px 0";
  controls.innerHTML = '<label>Minimum games<select id="attendance-min-games"><option value="0">All players</option><option value="100">100+ games</option><option value="250">250+ games</option><option value="500">500+ games</option></select></label>';
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
    chart.update();
  };
  document.getElementById("attendance-min-games").onchange = applyFilter;
}

document.addEventListener("DOMContentLoaded", () => {
  setupProfileCareerTrends();
  setupAllTimeCareerLeaders();
  setupAttendanceFilter();
  const allTimeView = document.getElementById("view-alltime");
  if (allTimeView) new MutationObserver(setupAttendanceFilter).observe(allTimeView, { childList: true, subtree: true });
});
