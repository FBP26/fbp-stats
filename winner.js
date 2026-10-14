const app = document.getElementById("winner-app");
const colors = ["#55d7b0", "#8aa8ff", "#ff9c74", "#c18cff", "#ef758d", "#76c7ff", "#a5d66a", "#ffca6b", "#69d1d7", "#d99bff", "#f58db2", "#9eaef8"];
const charts = [];
let recapData = null;
let raceFrames = [];
let raceFrame = 0;
let raceTimer = null;
let playbackSpeed = 1;

const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const normalize = value => String(value || "").trim().toLowerCase();
const ordinal = value => {
  const number = Number(value);
  if (number % 100 >= 11 && number % 100 <= 13) return `${number}th`;
  return `${number}${({ 1: "st", 2: "nd", 3: "rd" })[number % 10] || "th"}`;
};
const formatMoney = value => `$${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const formatDuration = milliseconds => {
  const minutes = Math.max(0, Math.round(milliseconds / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};
const playerColor = (name, alpha = 1) => {
  let hash = 0;
  for (const character of String(name)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const hex = colors[hash % colors.length];
  if (alpha === 1) return hex;
  const red = parseInt(hex.slice(1, 3), 16), green = parseInt(hex.slice(3, 5), 16), blue = parseInt(hex.slice(5, 7), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
};

function params() {
  const query = new URLSearchParams(location.search);
  return { season: Number(query.get("season") || 2026), week: Number(query.get("week") || 5) };
}

function dataFile(season, week) {
  return `data/winner-recaps/${season}-${season + 1}_week_${String(week).padStart(2, "0")}.json`;
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function careerText(winner) {
  const career = winner.career || {};
  const titles = [
    career.weeklyWins ? `${career.weeklyWins} weekly win${career.weeklyWins === 1 ? "" : "s"}` : "",
    career.playoffWins ? `${career.playoffWins} playoff win${career.playoffWins === 1 ? "" : "s"}` : "",
    career.seasonChampionships ? `${career.seasonChampionships} season championship${career.seasonChampionships === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const titleText = titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(", ")}${titles.length > 2 ? "," : ""} and ${titles.at(-1)}`;
  return `${winner.name} has won ${formatMoney(career.money)} total in the pool.${titleText ? ` Career titles: ${titleText}.` : ""}`;
}

function winnerSummary(data, winner) {
  const tied = data.players.filter(player => player.wins === winner.wins);
  const runner = tied.find(player => player.name !== winner.name && player.tiebreakerDiff > winner.tiebreakerDiff);
  const margin = runner ? runner.tiebreakerDiff - winner.tiebreakerDiff : null;
  return `${tied.length} player${tied.length === 1 ? "" : "s"} finished at ${winner.wins} wins. The actual total of ${winner.actualTiebreaker} landed in ${winner.name}'s range; ${winner.name}'s guess of ${winner.tiebreaker} was ${winner.tiebreakerDiff} yards away${runner ? `, ${margin} yard${margin === 1 ? "" : "s"} closer than ${runner.name}'s guess` : ""}.`;
}

function confirmationHtml(data, winner) {
  const gameByNumber = new Map(data.games.map(game => [game.gameNum, game]));
  const picks = winner.picks.map((pick, index) => {
    const game = gameByNumber.get(index + 1);
    const correct = game?.winner === pick;
    return `<div class="pick ${game?.winner === "PUSH" ? "" : correct ? "correct" : "wrong"}">${winner.bestBet === pick ? "<em>BEST BET</em>" : ""}<small>Game ${index + 1} - ${escapeHtml(game?.away)} at ${escapeHtml(game?.home)}</small><strong>${escapeHtml(pick)}</strong></div>`;
  }).join("");
  return `<section class="section">
    <div class="section-heading"><div><h2>The winning entry</h2><p>The confirmation details and every pick exactly as finalized.</p></div><span class="pill">${escapeHtml(data.archiveFile)}</span></div>
    <div class="confirmation-grid">
      <article class="winner-card">
        <h3>${escapeHtml(winner.name)}</h3>
        <div class="week-name">${escapeHtml(winner.weekName || `Week ${data.week}`)}</div>
        <p><strong>${winner.wins}-${winner.losses}${winner.pushes ? `-${winner.pushes}` : ""}</strong> with ${escapeHtml(winner.bestBet)} as the Best Bet.</p>
        <p>Tiebreak guess <strong>${winner.tiebreaker}</strong>; actual <strong>${winner.actualTiebreaker}</strong>; ${winner.tiebreakerDiff} yards away.</p>
        <p class="career-line">${escapeHtml(careerText(winner))}</p>
      </article>
      <div class="picks-grid">${picks}</div>
    </div>
  </section>`;
}

function highlightsHtml(data, winner) {
  const highlights = winner.highlights;
  const sharpest = highlights.sharpest.map(pick => `${pick.pick} (${pick.support} of ${data.players.length})`).join(", ");
  return `<section class="section">
    <div class="section-heading"><div><h2>How ${escapeHtml(winner.name)} won it</h2><p>The picks that separated the winner from the field.</p></div></div>
    <div class="highlight-grid">
      <div class="highlight"><span>Correct picks</span><strong>${highlights.correctPicks} of ${data.games.length}</strong></div>
      <div class="highlight"><span>Underdogs</span><strong>${highlights.correctUnderdogs} of ${highlights.underdogPicks} hit</strong></div>
      <div class="highlight"><span>Sharpest winners</span><strong>${escapeHtml(sharpest || "No minority picks")}</strong></div>
    </div>
  </section>`;
}

function tiebreakSegments(data, winner) {
  const tied = data.players.filter(player => player.wins === winner.wins).sort((left, right) => left.tiebreaker - right.tiebreaker);
  const groups = [];
  tied.forEach(player => {
    const group = groups.find(item => item.guess === player.tiebreaker);
    if (group) group.players.push(player);
    else groups.push({ guess: player.tiebreaker, players: [player] });
  });
  return groups.map((group, index) => {
    const low = index ? Math.floor((groups[index - 1].guess + group.guess) / 2) + 1 : Number.NEGATIVE_INFINITY;
    const high = index < groups.length - 1 ? Math.floor((group.guess + groups[index + 1].guess) / 2) : Number.POSITIVE_INFINITY;
    const range = index === 0 ? `${high} and below` : index === groups.length - 1 ? `${low} and up` : `${low}-${high}`;
    return { ...group, low, high, range, actual: winner.actualTiebreaker >= low && winner.actualTiebreaker <= high };
  });
}

function tiebreakHtml(data, winner) {
  const segments = tiebreakSegments(data, winner);
  const edge = Math.max(30, Math.round((segments.at(-1).guess - segments[0].guess) * .3));
  const displayLow = Math.min(segments[0].guess - edge, winner.actualTiebreaker);
  const displayHigh = Math.max(segments.at(-1).guess + edge, winner.actualTiebreaker);
  const span = displayHigh - displayLow || 1;
  const cells = segments.map((segment, index) => {
    const low = index ? segment.low : displayLow;
    const high = index === segments.length - 1 ? displayHigh : segment.high;
    const width = Math.max(12, 100 * (high - low) / span);
    return `<div class="tiebreak-segment ${segment.actual ? "actual" : ""}" style="flex:${width};background:${playerColor(segment.players[0].name, .68)}"><strong>${escapeHtml(segment.players.map(player => player.name).join(" / "))}</strong><span>Guess ${segment.guess}</span><span>${escapeHtml(segment.range)}</span>${segment.actual ? `<span class="actual-badge">Actual ${winner.actualTiebreaker}</span>` : ""}</div>`;
  }).join("");
  return `<section class="section">
    <div class="section-heading"><div><h2>Tiebreak landing</h2><p>${escapeHtml(winnerSummary(data, winner))}</p></div></div>
    <div class="tiebreak-track">${cells}</div>
  </section>`;
}

function startedGame(game) {
  const status = String(game.status || game.state || "").toUpperCase();
  return !["", "PRE", "PREGAME", "SCHEDULED", "STATUS_SCHEDULED"].includes(status);
}

function gameStateFor(staticGame, gameState) {
  return gameState.find(game => normalize(game.away) === normalize(staticGame.away) && normalize(game.home) === normalize(staticGame.home));
}

function playerLiveScore(data, player, snapshot) {
  let wins = 0, losses = 0;
  data.games.forEach((game, index) => {
    const live = gameStateFor(game, snapshot.gameState || []);
    if (!live || !startedGame(live)) return;
    const favoriteIsHome = normalize(game.favorite) === normalize(game.home);
    const favoriteScore = Number(favoriteIsHome ? live.homeScore : live.awayScore);
    const underdogScore = Number(favoriteIsHome ? live.awayScore : live.homeScore);
    if (!Number.isFinite(favoriteScore) || !Number.isFinite(underdogScore)) return;
    const margin = favoriteScore - underdogScore - Number(game.spread);
    const leader = margin === 0 ? "PUSH" : margin > 0 ? game.favorite : game.underdog;
    const pick = player.picks[index];
    if (leader === "PUSH") return;
    if (pick === leader) wins += 1 + (player.bestBet === pick ? 1 : 0);
    else losses += 1;
  });
  const decisions = wins + losses;
  return { wins, winPct: decisions ? 100 * wins / decisions : 0 };
}

function fallbackFrames(data) {
  const gameState = [];
  return data.games.map((game, index) => {
    gameState.push({ away: game.away, home: game.home, awayScore: game.awayScore, homeScore: game.homeScore, status: "FINAL" });
    return {
      timestamp: `${game.date || `Game ${index + 1}`}T12:00:00`,
      label: `Game ${index + 1}`,
      gameState: structuredClone(gameState),
      players: data.players.map(player => ({ name: player.name, winProbability: 0, pathsToVictory: 0, winPercent: playerLiveScore(data, player, { gameState }).winPct })),
      reconstructed: true,
    };
  });
}

function prepareRaceFrames(data) {
  const snapshots = data.raceSnapshots?.length ? data.raceSnapshots : fallbackFrames(data);
  return snapshots.map((snapshot, index) => {
    const racePlayers = new Map((snapshot.players || []).map(player => [normalize(player.name), player]));
    const players = data.players.map(player => {
      const live = playerLiveScore(data, player, snapshot);
      const race = racePlayers.get(normalize(player.name));
      return {
        name: player.name,
        wins: live.wins,
        winPct: race ? Number(race.winPercent || live.winPct) : live.winPct,
        winProbability: race ? Number(race.winProbability || 0) : null,
        pathsToVictory: race ? Number(race.pathsToVictory || 0) : null,
      };
    });
    const stamp = new Date(snapshot.timestamp);
    const label = snapshot.label || (Number.isNaN(stamp.getTime()) ? `Frame ${index + 1}` : stamp.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }));
    return { ...snapshot, label, players };
  });
}

function metricDescription(metric) {
  return {
    wins: "Weighted points at each saved checkpoint. A correct Best Bet counts twice.",
    winPct: "Weighted win percentage as the live results changed.",
    winProbability: "Modeled chance to win the week at each preserved snapshot.",
    pathsToVictory: "The number of remaining result combinations that still produced a win.",
  }[metric];
}

function chartDatasets(data, metric, winnerName) {
  return data.players.map(player => {
    const winner = normalize(player.name) === normalize(winnerName);
    return {
      label: player.name,
      data: raceFrames.map((frame, index) => index <= raceFrame ? frame.players.find(item => normalize(item.name) === normalize(player.name))?.[metric] ?? null : null),
      borderColor: winner ? "#f4c44f" : playerColor(player.name, .34),
      backgroundColor: winner ? "#f4c44f" : playerColor(player.name, .5),
      borderWidth: winner ? 4 : 1.2,
      pointRadius: raceFrames.map((_, index) => index === raceFrame ? winner ? 5 : 2 : 0),
      pointHoverRadius: winner ? 7 : 4,
      spanGaps: false,
      tension: .18,
      order: winner ? 0 : 1,
    };
  });
}

function createRaceCharts(data, winner) {
  const metrics = [
    ["wins", "Live wins"],
    ["winPct", "Live win percentage"],
    ["winProbability", "Win probability"],
    ["pathsToVictory", "Paths to victory"],
  ];
  metrics.forEach(([metric, title]) => {
    const canvas = document.getElementById(`race-${metric}`);
    const chart = new Chart(canvas, {
      type: "line",
      data: { labels: raceFrames.map(frame => frame.label), datasets: chartDatasets(data, metric, winner.name) },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: false },
        scales: {
          x: { display: false, grid: { display: false } },
          y: {
            beginAtZero: true,
            suggestedMax: metric === "winProbability" || metric === "winPct" ? 100 : undefined,
            max: metric === "winProbability" || metric === "winPct" ? 100 : undefined,
            ticks: { color: "#8298a7", callback: value => metric === "winProbability" || metric === "winPct" ? `${value}%` : Number(value).toLocaleString() },
            grid: { color: "rgba(255,255,255,.07)" },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: context => context.raw != null,
            callbacks: { label: context => `${context.dataset.label}: ${metric === "winProbability" || metric === "winPct" ? `${Number(context.raw).toFixed(1)}%` : Number(context.raw).toLocaleString()}` },
          },
        },
      },
    });
    charts.push({ metric, chart, winnerName: winner.name });
    document.getElementById(`description-${metric}`).textContent = metricDescription(metric);
    document.getElementById(`title-${metric}`).textContent = title;
  });
}

function raceHtml(data) {
  const sourceNote = data.raceSnapshots?.length ? `${data.raceSnapshots.length} preserved frames from ${data.raceSource}` : "Reconstructed from finalized games";
  return `<section class="section race-shell">
    <div class="race-toolbar">
      <div class="race-toolbar-top"><div><div class="eyebrow">Preserved live race</div><div id="race-time" class="race-time">Loading checkpoint...</div></div><div><div id="race-progress" class="race-progress"></div><span class="winner-key">Winner highlighted</span></div></div>
      <div class="race-controls">
        <button id="race-restart" type="button">Restart</button><button id="race-previous" type="button">Previous</button><button id="race-play" class="primary" type="button">Play</button><button id="race-next" type="button">Next</button>
        <input id="race-slider" type="range" min="0" max="${Math.max(0, raceFrames.length - 1)}" value="0" aria-label="Race checkpoint">
        <select id="race-speed" aria-label="Playback speed"><option value=".5">0.5x</option><option value="1" selected>1x</option><option value="2">2x</option><option value="4">4x</option></select>
      </div>
    </div>
    <div class="race-body">
      <div class="section-heading"><div><h2>Watch the week unfold</h2><p>All four views share one timeline. The winner's line stays gold while the rest of the field remains visible.</p></div><span class="pill">${escapeHtml(sourceNote)}</span></div>
      <div class="metric-grid">${["wins", "winPct", "winProbability", "pathsToVictory"].map(metric => `<article class="chart-card"><h3 id="title-${metric}"></h3><p id="description-${metric}"></p><div class="chart-wrap"><canvas id="race-${metric}"></canvas></div></article>`).join("")}</div>
      <div id="leadership" class="leadership-grid"></div>
    </div>
  </section>`;
}

function liveFrame(frame) {
  return (frame.gameState || []).some(game => ["IN", "IN_PROGRESS", "LIVE", "STATUS_IN_PROGRESS"].includes(String(game.status || game.state || "").toUpperCase()));
}

function leadershipAnalysis(winnerName) {
  const intervals = [];
  for (let index = 0; index < Math.min(raceFrame + 1, raceFrames.length - 1); index += 1) {
    const frame = raceFrames[index], next = raceFrames[index + 1];
    if (!liveFrame(frame)) continue;
    const available = frame.players.filter(player => player.winProbability != null);
    if (!available.length) continue;
    const top = Math.max(...available.map(player => player.winProbability));
    const names = available.filter(player => player.winProbability === top).map(player => player.name).sort();
    const start = new Date(frame.timestamp).getTime(), end = new Date(next.timestamp).getTime();
    const duration = Math.min(10 * 60 * 1000, end - start);
    if (names.length && Number.isFinite(duration) && duration > 0) intervals.push({ name: names.join(" + "), duration, start, end, winnerOnTop: names.some(name => normalize(name) === normalize(winnerName)) });
  }
  const reigns = [], totals = new Map();
  intervals.forEach(interval => {
    totals.set(interval.name, (totals.get(interval.name) || 0) + interval.duration);
    const latest = reigns.at(-1);
    if (latest?.name === interval.name) {
      latest.duration += interval.duration;
      latest.end = interval.end;
    } else {
      reigns.push({ ...interval });
    }
  });
  return { intervals, reigns, totals, totalDuration: intervals.reduce((total, interval) => total + interval.duration, 0) };
}

function renderLeadership(winnerName) {
  const host = document.getElementById("leadership");
  const analysis = leadershipAnalysis(winnerName);
  if (!analysis.intervals.length) {
    host.innerHTML = '<div class="empty-note">Time on top begins when preserved snapshots show a live game.</div>';
    return;
  }
  const leadChanges = analysis.reigns.slice(1);
  const trail = analysis.reigns.map(reign => `<span class="leader-segment" style="flex:${reign.duration};background:${normalize(reign.name).includes(normalize(winnerName)) ? "#9b7a22" : playerColor(reign.name, .72)}" title="${escapeHtml(reign.name)} - ${formatDuration(reign.duration)}">${reign.duration / analysis.totalDuration > .07 ? escapeHtml(reign.name) : ""}</span>`).join("");
  const leaders = [...analysis.totals].sort((left, right) => right[1] - left[1]).map(([name, duration]) => `<div class="leader-stat" style="--runner-color:${normalize(name).includes(normalize(winnerName)) ? "#f4c44f" : playerColor(name)}"><strong>${escapeHtml(name)}</strong><span>${formatDuration(duration)} on top</span></div>`).join("");
  const changes = leadChanges.slice(-8).reverse().map(change => `<div class="lead-change" style="--runner-color:${normalize(change.name).includes(normalize(winnerName)) ? "#f4c44f" : playerColor(change.name)}"><strong>${escapeHtml(change.name)} took over</strong><time>${new Date(change.start).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</time></div>`).join("");
  host.innerHTML = `<div><div class="section-heading"><div><h2>Time on top</h2><p>${leadChanges.length} lead change${leadChanges.length === 1 ? "" : "s"} through this checkpoint.</p></div></div><div class="leader-trail">${trail}</div><div class="leader-stats">${leaders}</div></div><div><div class="section-heading"><div><h2>Lead changes</h2><p>Most recent takeover first.</p></div></div><div class="lead-change-list">${changes || '<div class="empty-note">No lead changes yet.</div>'}</div></div>`;
}

function updateRaceFrame(index) {
  raceFrame = Math.max(0, Math.min(raceFrames.length - 1, Number(index)));
  const frame = raceFrames[raceFrame];
  const stamp = new Date(frame.timestamp);
  document.getElementById("race-time").textContent = Number.isNaN(stamp.getTime()) ? frame.label : stamp.toLocaleString([], { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  document.getElementById("race-progress").textContent = `Checkpoint ${raceFrame + 1} of ${raceFrames.length}`;
  document.getElementById("race-slider").value = raceFrame;
  charts.forEach(item => {
    item.chart.data.datasets = chartDatasets(recapData, item.metric, item.winnerName);
    item.chart.update("none");
  });
  renderLeadership(recapData.winners[0].name);
}

function stopRace() {
  if (raceTimer) clearTimeout(raceTimer);
  raceTimer = null;
  const button = document.getElementById("race-play");
  if (button) button.textContent = "Play";
}

function advanceRace() {
  if (!raceTimer) return;
  if (raceFrame >= raceFrames.length - 1) {
    stopRace();
    return;
  }
  updateRaceFrame(raceFrame + 1);
  raceTimer = setTimeout(advanceRace, Math.max(70, 650 / playbackSpeed));
}

function bindRaceControls() {
  document.getElementById("race-restart").onclick = () => { stopRace(); updateRaceFrame(0); };
  document.getElementById("race-previous").onclick = () => { stopRace(); updateRaceFrame(raceFrame - 1); };
  document.getElementById("race-next").onclick = () => { stopRace(); updateRaceFrame(raceFrame + 1); };
  document.getElementById("race-slider").oninput = event => { stopRace(); updateRaceFrame(event.target.value); };
  document.getElementById("race-speed").onchange = event => { playbackSpeed = Number(event.target.value) || 1; };
  document.getElementById("race-play").onclick = event => {
    if (raceTimer) { stopRace(); return; }
    if (raceFrame >= raceFrames.length - 1) updateRaceFrame(0);
    event.currentTarget.textContent = "Pause";
    raceTimer = setTimeout(advanceRace, Math.max(70, 650 / playbackSpeed));
  };
}

function sankeyHtml(data, winner) {
  return `<section class="section">
    <div class="section-heading"><div><h2>The thread that made it all the way</h2><p>The possibility chart is collapsed to the one realized route. Green links are winning picks, red links are misses, and the gold finish is the tiebreaker that delivered the week.</p></div></div>
    <div class="sankey-wrap"><canvas id="winner-sankey" class="sankey-canvas"></canvas></div>
    <p class="route-note">Scroll sideways to follow every completed game from kickoff to ${escapeHtml(winner.name)}. Hover a link for the result and pick.</p>
  </section>`;
}

function createSankey(data, winner) {
  const labels = { start: "Kickoff" };
  const edges = [];
  let from = "start";
  data.games.forEach((game, index) => {
    const correct = winner.picks[index] === game.winner;
    const node = `game:${game.gameNum}`;
    labels[node] = `G${game.gameNum} ${game.winner === "PUSH" ? "push" : `${game.winner} covers`}`;
    edges.push({ from, to: node, flow: 1, correct, detail: `${game.away} at ${game.home}: ${game.winner === "PUSH" ? "push" : `${game.winner} covered`}; ${winner.name} picked ${winner.picks[index]}` });
    from = node;
  });
  const tiebreakNode = "tiebreak";
  labels[tiebreakNode] = `TB actual ${winner.actualTiebreaker}`;
  edges.push({ from, to: tiebreakNode, flow: 1, tiebreak: true, detail: `${winner.name} guessed ${winner.tiebreaker} and missed by ${winner.tiebreakerDiff} yards` });
  labels.winner = `${winner.name} wins`;
  edges.push({ from: tiebreakNode, to: "winner", flow: 1, tiebreak: true, detail: `${winner.name} wins Week ${data.week}` });
  new Chart(document.getElementById("winner-sankey"), {
    type: "sankey",
    data: { datasets: [{ data: edges, labels, colorFrom: context => context.raw.tiebreak ? "#f4c44f" : context.raw.correct ? "#55d7b0" : "#f4847a", colorTo: context => context.raw.tiebreak ? "#f4c44f" : context.raw.correct ? "#55d7b0" : "#f4847a", colorMode: "gradient", borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, color: "#edf4f8", layout: { padding: { right: 110 } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => context.raw.detail } } } },
  });
}

function helpedHtml(winner) {
  const rows = [...winner.highlights.helped].sort((left, right) => left.rank - right.rank).map(item => {
    const positive = item.percent > .001, negative = item.percent < -.001;
    return `<tr class="${positive ? "positive" : negative ? "negative" : ""}"><td>${item.gameNum}</td><td>${escapeHtml(item.matchup)}</td><td><strong>${escapeHtml(item.pick)}</strong></td><td>${escapeHtml(item.result)}</td><td class="${positive ? "positive-value" : negative ? "negative-value" : ""}">${item.percent > 0 ? "+" : ""}${item.percent.toFixed(1)}%</td><td>${ordinal(item.rank)}</td></tr>`;
  }).join("");
  return `<section class="section">
    <div class="section-heading"><div><h2>Which games helped most</h2><p>Helped compares the winner's weighted points with the average points earned by the rest of the field. Best Bet is worth two.</p></div></div>
    <div class="table-scroll"><table class="helped-table"><thead><tr><th>#</th><th>Game</th><th>Pick</th><th>Result</th><th>Helped</th><th>Rank</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

async function archiveHtml(current) {
  const archive = await loadJson("data/winner-recaps/index.json");
  const cards = [...archive.weeks].reverse().map(item => `<a class="archive-card ${item.season === current.season && item.week === current.week ? "current" : ""}" href="winner.html?season=${item.season}&week=${item.week}"><small>${escapeHtml(item.seasonLabel)} - Week ${item.week}</small><strong>${escapeHtml(item.winners.join(" / "))}</strong><span>${escapeHtml(item.record)}${item.weekName ? ` - ${escapeHtml(item.weekName)}` : ""}</span><small>${item.raceFrames} preserved race frames</small></a>`).join("");
  return `<section id="winner-archive" class="section"><div class="section-heading"><div><h2>Weekly winner archive</h2><p>Every finalized winner gets a permanent page at its own season and week URL.</p></div></div><div class="archive-grid">${cards}</div></section>`;
}

function heroHtml(data, winner) {
  const record = `${winner.wins}-${winner.losses}${winner.pushes ? `-${winner.pushes}` : ""}`;
  return `<section class="hero">
    <p class="eyebrow">${escapeHtml(data.seasonLabel)} - Week ${data.week} winner</p>
    <h1>${escapeHtml(data.winners.map(item => item.name).join(" + "))}</h1>
    <p class="hero-summary">${escapeHtml(winnerSummary(data, winner))}</p>
    <div class="hero-actions"><button id="share-winner" class="button primary" type="button">Share this winner page</button><button id="copy-winner" class="button" type="button">Copy link</button><a class="button" href="#live-race">Watch the race</a></div>
    <div class="stat-grid">
      <div class="stat"><span>Final record</span><strong>${record}</strong></div>
      <div class="stat"><span>Week name</span><strong>${escapeHtml(winner.weekName || "-")}</strong></div>
      <div class="stat"><span>Best Bet</span><strong>${escapeHtml(winner.bestBet)}</strong></div>
      <div class="stat"><span>Tiebreak miss</span><strong>${winner.tiebreakerDiff} yards</strong></div>
    </div>
  </section>`;
}

function bindSharing(data, winner) {
  const text = `${winner.name} won FBP Week ${data.week} at ${winner.wins}-${winner.losses}. Watch the preserved race: ${location.href}`;
  document.getElementById("copy-winner").onclick = async event => {
    await navigator.clipboard.writeText(location.href);
    event.currentTarget.textContent = "Link copied";
    setTimeout(() => { event.currentTarget.textContent = "Copy link"; }, 1800);
  };
  document.getElementById("share-winner").onclick = async () => {
    if (navigator.share) await navigator.share({ title: document.title, text, url: location.href });
    else await navigator.clipboard.writeText(text);
  };
}

async function render() {
  try {
    const selected = params();
    recapData = await loadJson(dataFile(selected.season, selected.week));
    const winner = recapData.winners[0];
    document.title = `${winner.name} - FBP Week ${recapData.week} Winner`;
    raceFrames = prepareRaceFrames(recapData);
    raceFrame = Math.max(0, raceFrames.length - 1);
    app.innerHTML = [
      heroHtml(recapData, winner),
      confirmationHtml(recapData, winner),
      highlightsHtml(recapData, winner),
      tiebreakHtml(recapData, winner),
      `<div id="live-race">${raceHtml(recapData)}</div>`,
      sankeyHtml(recapData, winner),
      helpedHtml(winner),
      await archiveHtml(selected),
    ].join("");
    createRaceCharts(recapData, winner);
    createSankey(recapData, winner);
    bindRaceControls();
    bindSharing(recapData, winner);
    updateRaceFrame(raceFrame);
  } catch (error) {
    console.error(error);
    app.innerHTML = `<section class="error-state"><p class="eyebrow">Winner page unavailable</p><h1>This preserved recap could not load.</h1><p>${escapeHtml(error.message)}</p><a class="button primary" href="winner.html">Open the winner archive</a></section>`;
  }
}

render();
