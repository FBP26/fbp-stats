const app = document.getElementById("winner-app");
const colors = ["#55d7b0", "#8aa8ff", "#ff9c74", "#c18cff", "#ef758d", "#76c7ff", "#a5d66a", "#ffca6b", "#69d1d7", "#d99bff", "#f58db2", "#9eaef8"];
const charts = [];
let recapData = null;
let raceFrames = [];
let raceFrame = 0;
let raceTimer = null;
const RACE_DURATION_MS = 60000;
let playbackSpeed = 1;
let frameDelays = [];

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

function winnerFinishText(data, winner) {
  const tied = data.players.filter(player => player.wins === winner.wins);
  const others = tied.filter(player => normalize(player.name) !== normalize(winner.name)).map(player => player.name);
  if (!others.length) return `${winner.name} finished with ${winner.wins} wins, alone at the top of the week.`;
  const names = others.length === 1 ? others[0] : `${others.slice(0, -1).join(", ")} and ${others.at(-1)}`;
  return `${winner.name} finished with ${winner.wins} wins, tied with ${names}.`;
}

function helpedByGame(winner) {
  return new Map((winner.highlights?.helped || []).map(item => [item.gameNum, item]));
}

function helpedTone(percent) {
  return percent > .001 ? "positive-value" : percent < -.001 ? "negative-value" : "neutral-value";
}

function helpedLabel(item) {
  if (!item) return "";
  return `${item.percent > 0 ? "+" : ""}${item.percent.toFixed(1)}%`;
}

function impactText(item) {
  if (!item) return "No impact";
  return `${helpedLabel(item)} ${item.percent < -.001 ? "hurt" : "helped"}`;
}

function confirmationHtml(data, winner) {
  const gameByNumber = new Map(data.games.map(game => [game.gameNum, game]));
  const helped = helpedByGame(winner);
  const picks = winner.picks.map((pick, index) => {
    const game = gameByNumber.get(index + 1);
    const correct = game?.winner === pick;
    const impact = helped.get(index + 1);
    const bestBet = winner.bestBet === pick;
    return `<div class="pick ${game?.winner === "PUSH" ? "" : correct ? "correct" : "wrong"}">
      <small>Game ${index + 1} - ${escapeHtml(game?.away)} at ${escapeHtml(game?.home)}</small>
      <strong>${escapeHtml(pick)}</strong>
      ${bestBet ? '<em class="best-bet-tag">BEST BET</em>' : ""}
      <span class="pick-helped ${helpedTone(impact?.percent || 0)}">${impactText(impact)}</span>
    </div>`;
  }).join("");
  return `<section class="section">
    <div class="section-heading"><div><h2>The winning entry</h2></div><span class="pill">${escapeHtml(data.archiveFile)}</span></div>
    <div class="confirmation-grid">
      <article class="winner-card">
        <h3>${escapeHtml(winner.name)}</h3>
        <div class="week-name">${escapeHtml(winner.weekName || `Week ${data.week}`)}</div>
        <p><strong>${winner.wins}-${winner.losses}${winner.pushes ? `-${winner.pushes}` : ""}</strong> with ${escapeHtml(winner.bestBet)} as the Best Bet.</p>
        <p>${escapeHtml(winnerFinishText(data, winner))}</p>
        <p>Tiebreak guess <strong>${winner.tiebreaker}</strong>; actual <strong>${winner.actualTiebreaker}</strong>; ${winner.tiebreakerDiff} yards away.</p>
        <p><strong>Underdogs:</strong> ${winner.highlights.correctUnderdogs} of ${winner.highlights.underdogPicks} hit.</p>
        <p class="career-line">${escapeHtml(careerText(winner))}</p>
      </article>
      <div class="picks-grid">${picks}</div>
    </div>
  </section>`;
}

function standingsHtml(data) {
  const winnerNames = new Set(data.winners.map(item => normalize(item.name)));
  const ranked = [...data.players].sort((left, right) => right.wins - left.wins || left.tiebreakerDiff - right.tiebreakerDiff || String(left.name).localeCompare(String(right.name)));
  let place = 0, previous = "";
  const rows = ranked.map((player, index) => {
    const key = `${player.wins}|${player.tiebreakerDiff}`;
    if (key !== previous) { place = index + 1; previous = key; }
    const isWinner = winnerNames.has(normalize(player.name));
    return `<tr class="${isWinner ? "winner-row" : ""}">
      <td>${ordinal(place)}</td>
      <td><strong>${escapeHtml(player.name)}</strong>${isWinner ? '<em class="winner-tag">WINNER</em>' : ""}</td>
      <td>${escapeHtml(player.weekName || "-")}</td>
      <td>${player.wins}-${player.losses}${player.pushes ? `-${player.pushes}` : ""}</td>
      <td>${escapeHtml(player.bestBet || "-")}</td>
      <td>${player.tiebreaker}</td>
      <td>${player.tiebreakerDiff}</td>
    </tr>`;
  }).join("");
  return `<section class="section">
    <div class="section-heading"><div><h2>Week ${data.week} standings</h2></div><span class="pill">${data.players.length} entries</span></div>
    <div class="table-scroll"><table class="helped-table standings-table"><thead><tr><th>Place</th><th>Entry</th><th>Week name</th><th>Record</th><th>Best Bet</th><th>Tiebreak</th><th>Off by</th></tr></thead><tbody>${rows}</tbody></table></div>
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
  const segmentColors = ["#236b8e", "#8f4f73", "#31796d", "#8a6234", "#6557a5", "#a34f46"];
  const segments = tiebreakSegments(data, winner);
  const edge = Math.max(30, Math.round((segments.at(-1).guess - segments[0].guess) * .3));
  const displayLow = Math.min(segments[0].guess - edge, winner.actualTiebreaker);
  const displayHigh = Math.max(segments.at(-1).guess + edge, winner.actualTiebreaker);
  const span = displayHigh - displayLow || 1;
  const cells = segments.map((segment, index) => {
    const low = index ? segment.low : displayLow;
    const high = index === segments.length - 1 ? displayHigh : segment.high;
    const width = Math.max(12, 100 * (high - low) / span);
    return `<div class="tiebreak-segment ${segment.actual ? "actual" : ""}" style="flex:${width};background:${segmentColors[index % segmentColors.length]}"><strong>${escapeHtml(segment.players.map(player => player.name).join(" / "))}</strong><span>Guess ${segment.guess}</span><span>${escapeHtml(segment.range)}</span>${segment.actual ? `<span class="actual-badge">Actual ${winner.actualTiebreaker}</span>` : ""}</div>`;
  }).join("");
  return `<section class="section">
    <div class="section-heading"><div><h2>Tiebreak landing</h2></div></div>
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
        tiebreakerDiff: Number(player.tiebreakerDiff ?? 0),
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
      <div class="section-heading"><div><h2>Watch the week unfold</h2><p>All four views share one timeline. The full replay runs about 60 seconds at 1x, moving quickly when a single game is live and slowing down when many are. The winner's line stays gold while the rest of the field remains visible.</p></div><span class="pill">${escapeHtml(sourceNote)}</span></div>
      <div class="metric-grid">${["wins", "winPct", "winProbability", "pathsToVictory"].map(metric => `<article class="chart-card"><h3 id="title-${metric}"></h3><p id="description-${metric}"></p><div class="chart-wrap"><canvas id="race-${metric}"></canvas></div></article>`).join("")}</div>
      <div id="leadership" class="leadership-grid"></div>
    </div>
  </section>`;
}

function liveGameCount(frame) {
  return (frame.gameState || []).filter(game => ["IN", "IN_PROGRESS", "LIVE", "STATUS_IN_PROGRESS"].includes(String(game.status || game.state || "").toUpperCase())).length;
}

function startedGameCount(frame) {
  return (frame.gameState || []).filter(game => startedGame(game)).length;
}

function computeFrameDelays() {
  const transitions = Math.max(0, raceFrames.length - 1);
  if (!transitions) {
    frameDelays = [];
    return;
  }
  const weights = [];
  for (let index = 0; index < transitions; index += 1) weights.push(Math.max(1, liveGameCount(raceFrames[index])));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || transitions;
  frameDelays = weights.map(weight => RACE_DURATION_MS * weight / total);
}

function frameDelay() {
  const fallback = RACE_DURATION_MS / Math.max(1, raceFrames.length - 1);
  return Math.max(16, (frameDelays[raceFrame] || fallback) / playbackSpeed);
}

function frameLeader(frame) {
  if (!startedGameCount(frame)) return null;
  return [...frame.players].sort((left, right) => right.wins - left.wins || left.tiebreakerDiff - right.tiebreakerDiff || String(left.name).localeCompare(String(right.name)))[0] || null;
}

function leadershipAnalysis(winnerName) {
  const intervals = [];
  const limit = Math.min(raceFrame, raceFrames.length - 1);
  for (let index = 0; index < limit; index += 1) {
    const frame = raceFrames[index], next = raceFrames[index + 1];
    const leader = frameLeader(frame);
    if (!leader) continue;
    const start = new Date(frame.timestamp).getTime(), end = new Date(next.timestamp).getTime();
    const duration = Math.min(10 * 60 * 1000, end - start);
    if (!Number.isFinite(duration) || duration <= 0) continue;
    intervals.push({ name: leader.name, duration, start, end, wins: leader.wins, frameIndex: index });
  }
  const reigns = [], totals = new Map();
  intervals.forEach(interval => {
    totals.set(interval.name, (totals.get(interval.name) || 0) + interval.duration);
    const latest = reigns.at(-1);
    if (latest?.name === interval.name) {
      latest.duration += interval.duration;
      latest.end = interval.end;
      latest.wins = interval.wins;
    } else {
      reigns.push({ ...interval });
    }
  });
  if (!totals.has(winnerName)) totals.set(winnerName, 0);
  return { intervals, reigns, totals, totalDuration: intervals.reduce((total, interval) => total + interval.duration, 0) };
}

function leadChangeReason(frameIndex) {
  const frame = raceFrames[frameIndex];
  const previous = raceFrames[Math.max(0, frameIndex - 1)];
  const scores = [];
  (frame.gameState || []).forEach(game => {
    const before = gameStateFor(game, previous.gameState || []);
    if (!before) return;
    [
      { team: game.away, delta: Number(game.awayScore) - Number(before.awayScore) },
      { team: game.home, delta: Number(game.homeScore) - Number(before.homeScore) },
    ].forEach(score => {
      if (Number.isFinite(score.delta) && score.delta > 0) {
        scores.push({ ...score, away: game.away, home: game.home, awayScore: Number(game.awayScore), homeScore: Number(game.homeScore) });
      }
    });
  });
  const score = scores.sort((left, right) => right.delta - left.delta)[0];
  if (score) return `${score.team} scored ${score.delta} point${score.delta === 1 ? "" : "s"} (${score.away} ${score.awayScore}, ${score.home} ${score.homeScore})`;
  const kickoff = (frame.gameState || []).find(game => {
    const before = gameStateFor(game, previous.gameState || []);
    const beforeStatus = String(before?.status || before?.state || "").toUpperCase();
    const currentStatus = String(game.status || game.state || "").toUpperCase();
    return ["", "PRE", "PREGAME", "SCHEDULED", "STATUS_SCHEDULED"].includes(beforeStatus) && ["IN", "IN_PROGRESS", "LIVE", "STATUS_IN_PROGRESS"].includes(currentStatus);
  });
  if (kickoff) return `${kickoff.away} at ${kickoff.home} kicked off`;
  const final = (frame.gameState || []).find(game => {
    const before = gameStateFor(game, previous.gameState || []);
    return before && !["FINAL", "STATUS_FINAL"].includes(String(before.status || before.state || "").toUpperCase()) && ["FINAL", "STATUS_FINAL"].includes(String(game.status || game.state || "").toUpperCase());
  });
  if (final) return `${final.away} at ${final.home} went final (${final.away} ${final.awayScore}, ${final.home} ${final.homeScore})`;
  return "The live results shifted the standings";
}

function renderLeadership(winnerName) {
  const host = document.getElementById("leadership");
  const analysis = leadershipAnalysis(winnerName);
  if (!analysis.intervals.length) {
    host.innerHTML = '<div class="empty-note">Time on top begins once the first game of the week kicks off.</div>';
    return;
  }
  const leadChanges = analysis.reigns.slice(1);
  const trail = analysis.reigns.map(reign => {
    const share = 100 * reign.duration / analysis.totalDuration;
    return `<button type="button" class="leader-segment" style="flex:${reign.duration};background:${normalize(reign.name) === normalize(winnerName) ? "#9b7a22" : playerColor(reign.name, .72)}" data-name="${escapeHtml(reign.name)}" data-duration="${escapeHtml(formatDuration(reign.duration))}" data-share="${share.toFixed(1)}" aria-label="${escapeHtml(reign.name)}, ${escapeHtml(formatDuration(reign.duration))}, ${share.toFixed(1)} percent">${share > 7 ? escapeHtml(reign.name) : ""}</button>`;
  }).join("");
  const leaders = [...analysis.totals].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))).map(([name, duration]) => {
    const isWinner = normalize(name) === normalize(winnerName);
    const share = analysis.totalDuration ? 100 * duration / analysis.totalDuration : 0;
    return `<div class="leader-stat ${isWinner ? "winner-leader" : ""}" style="--runner-color:${isWinner ? "#f4c44f" : playerColor(name)}"><strong>${escapeHtml(name)}${isWinner ? '<em class="winner-tag">WINNER</em>' : ""}</strong><span>${duration ? `${formatDuration(duration)} (${share.toFixed(1)}%)` : "Never held the lead"}</span></div>`;
  }).join("");
  const changes = [...leadChanges].reverse().map(change => `<div class="lead-change ${normalize(change.name) === normalize(winnerName) ? "winner-leader" : ""}" style="--runner-color:${normalize(change.name) === normalize(winnerName) ? "#f4c44f" : playerColor(change.name)}"><div><strong>${escapeHtml(change.name)} moved into first place</strong><span>${escapeHtml(leadChangeReason(change.frameIndex))}</span></div><time>${new Date(change.start).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</time></div>`).join("");
  host.innerHTML = `<div><div class="section-heading"><div><h2>Time on top</h2><p>${leadChanges.length} lead change${leadChanges.length === 1 ? "" : "s"} through this checkpoint. The leader is the entry with the most weighted points, with ties going to the closest tiebreaker. Every entry that led is listed, and the winner is always shown.</p></div></div><div class="leader-trail">${trail}</div><div class="leader-stats">${leaders}</div></div><div><div class="section-heading"><div><h2>Lead changes</h2><p>All ${leadChanges.length} takeover${leadChanges.length === 1 ? "" : "s"}, most recent first.</p></div></div><div class="lead-change-list">${changes || '<div class="empty-note">No lead changes yet.</div>'}</div></div>`;
}

function bindLeadershipTooltips() {
  document.addEventListener("click", event => {
    document.querySelector(".leader-tooltip")?.remove();
    const segment = event.target.closest(".leader-segment");
    if (!segment) return;
    const tooltip = document.createElement("div");
    tooltip.className = "leader-tooltip";
    tooltip.textContent = `${segment.dataset.name}: ${segment.dataset.duration} (${segment.dataset.share}%)`;
    document.body.appendChild(tooltip);
    const bounds = segment.getBoundingClientRect();
    const tooltipBounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tooltipBounds.width - 8, bounds.left + bounds.width / 2 - tooltipBounds.width / 2))}px`;
    tooltip.style.top = `${Math.max(8, bounds.top - tooltipBounds.height - 8)}px`;
  });
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
  raceTimer = setTimeout(advanceRace, frameDelay());
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
    raceTimer = setTimeout(advanceRace, frameDelay());
  };
}

function spreadLabel(game, pick) {
  if (normalize(pick) === normalize(game.favorite)) return `-${Number(game.spread)}`;
  if (normalize(pick) === normalize(game.underdog)) return `+${Number(game.spread)}`;
  return "";
}

function gameOutcomeText(game, pick) {
  const awayScore = Number(game.awayScore);
  const homeScore = Number(game.homeScore);
  if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) {
    return game.winner === "PUSH" ? "The spread pushed" : `${game.winner} covered`;
  }
  if (awayScore === homeScore) return `${game.away} and ${game.home} tied ${awayScore}-${homeScore}`;
  const straightWinner = homeScore > awayScore ? game.home : game.away;
  const straightLoser = homeScore > awayScore ? game.away : game.home;
  const winnerScore = Math.max(homeScore, awayScore);
  const loserScore = Math.min(homeScore, awayScore);
  const pickWon = normalize(pick) === normalize(straightWinner);
  const covered = normalize(pick) === normalize(game.winner);
  const spread = spreadLabel(game, pick);
  if (game.winner === "PUSH") return `${straightWinner} won ${winnerScore}-${loserScore}; the spread pushed`;
  if (pickWon && covered) return `${pick} won ${winnerScore}-${loserScore} and covered ${spread}`;
  if (pickWon) return `${pick} won ${winnerScore}-${loserScore} but did not cover ${spread}`;
  if (covered) return `${pick} lost ${loserScore}-${winnerScore} but covered ${spread}`;
  return `${pick} lost ${loserScore}-${winnerScore} and did not cover ${spread}`;
}

function routeHtml(data, winner) {
  const helped = helpedByGame(winner);
  let wins = 0, losses = 0, pushes = 0;
  const steps = data.games.map((game, index) => {
    const pick = winner.picks[index];
    const push = game.winner === "PUSH";
    const correct = !push && game.winner === pick;
    if (push) pushes += 1;
    else if (correct) wins += 1;
    else losses += 1;
    const impact = helped.get(game.gameNum);
    const bestBet = winner.bestBet === pick;
    return `<li class="route-step ${push ? "push" : correct ? "hit" : "miss"}">
      <span class="route-node">G${game.gameNum}</span>
      <div class="route-detail">
        <small>${escapeHtml(game.away)} at ${escapeHtml(game.home)}</small>
        <strong>${escapeHtml(gameOutcomeText(game, pick))}${bestBet ? '<em class="best-bet-tag">BEST BET</em>' : ""}</strong>
        <span class="route-meta">Running ${wins}-${losses}${pushes ? `-${pushes}` : ""}${impact ? ` <b class="${helpedTone(impact.percent)}">${impactText(impact)}</b>` : ""}</span>
      </div>
    </li>`;
  }).join("");
  const chips = data.games.map((game, index) => {
    const pick = winner.picks[index];
    const push = game.winner === "PUSH";
    const correct = !push && game.winner === pick;
    return `<span class="thread-chip ${push ? "push" : correct ? "hit" : "miss"}" title="Game ${game.gameNum}: ${escapeHtml(pick)} ${push ? "pushed" : correct ? "covered" : "did not cover"}">${escapeHtml(pick)}</span>`;
  }).join("");
  return `<section class="section">
    <div class="section-heading"><div><h2>The thread that made it all the way</h2><p>Every completed game in order, from kickoff to the tiebreaker that delivered the week. Green is a winning pick, red is a miss, and gold is the finish.</p></div></div>
    <div class="thread-strip"><span class="thread-chip start">Kickoff</span>${chips}<span class="thread-chip finish">${escapeHtml(winner.name)}</span></div>
    <ol class="route-list">
      <li class="route-step start"><span class="route-node">GO</span><div class="route-detail"><small>Week ${data.week} kickoff</small><strong>${escapeHtml(winner.name)} is 0-0 with ${escapeHtml(winner.bestBet)} as the Best Bet</strong><span class="route-meta">Tiebreak guess ${winner.tiebreaker}</span></div></li>
      ${steps}
      <li class="route-step finish"><span class="route-node">TB</span><div class="route-detail"><small>Tiebreaker</small><strong>Actual total ${winner.actualTiebreaker}; ${escapeHtml(winner.name)} guessed ${winner.tiebreaker}</strong><span class="route-meta">${winner.tiebreakerDiff} yards away</span></div></li>
      <li class="route-step finish"><span class="route-node">W</span><div class="route-detail"><small>Final</small><strong>${escapeHtml(winner.name)} wins Week ${data.week} at ${winner.wins}-${winner.losses}${winner.pushes ? `-${winner.pushes}` : ""}</strong><span class="route-meta">${escapeHtml(winner.weekName || "")}</span></div></li>
    </ol>
  </section>`;
}

function helpedHtml(winner) {
  const rows = [...winner.highlights.helped].sort((left, right) => left.rank - right.rank).map(item => {
    const positive = item.percent > .001, negative = item.percent < -.001;
    return `<tr class="${positive ? "positive" : negative ? "negative" : ""}"><td>${item.gameNum}</td><td>${escapeHtml(item.matchup)}</td><td><strong>${escapeHtml(item.pick)}</strong></td><td>${escapeHtml(item.result)}</td><td class="${positive ? "positive-value" : negative ? "negative-value" : ""}">${impactText(item)}</td><td>${ordinal(item.rank)}</td></tr>`;
  }).join("");
  return `<section class="section">
    <div class="section-heading"><div><h2>Which games helped or hurt most</h2><p>Impact compares the winner's weighted points with the average points earned by the rest of the field. Best Bet is worth two.</p></div></div>
    <div class="table-scroll"><table class="helped-table"><thead><tr><th>#</th><th>Game</th><th>Pick</th><th>Result</th><th>Impact</th><th>Rank</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

async function archiveHtml(current) {
  const archive = await loadJson("data/winner-recaps/index.json");
  const cards = [...archive.weeks].reverse().map(item => `<a class="archive-card ${item.season === current.season && item.week === current.week ? "current" : ""}" href="winner.html?season=${item.season}&week=${item.week}"><small>${escapeHtml(item.seasonLabel)} - Week ${item.week}</small><strong>${escapeHtml(item.winners.join(" / "))}</strong><span>${escapeHtml(item.record)}</span>${item.weekName ? `<small class="archive-week-name">${escapeHtml(item.weekName)}</small>` : ""}</a>`).join("");
  return `<section id="winner-archive" class="section"><div class="section-heading"><div><h2>Weekly winner archive</h2><p>Every finalized winner gets a permanent page at its own season and week URL.</p></div></div><div class="archive-grid">${cards}</div></section>`;
}

function heroHtml(data, winner) {
  const record = `${winner.wins}-${winner.losses}${winner.pushes ? `-${winner.pushes}` : ""}`;
  return `<section class="hero">
    <p class="eyebrow">${escapeHtml(data.seasonLabel)} - Week ${data.week} winner</p>
    <h1>${escapeHtml(data.winners.map(item => item.name).join(" + "))}</h1>
    <p class="hero-week-name">${escapeHtml(winner.weekName || `Week ${data.week}`)}</p>
    <div class="stat-grid">
      <div class="stat"><span>Final record</span><strong>${record}</strong></div>
      <div class="stat"><span>Best Bet</span><strong>${escapeHtml(winner.bestBet)}</strong></div>
      <div class="stat"><span>Correct picks</span><strong>${winner.highlights.correctPicks} of ${data.games.length}</strong></div>
      <div class="stat"><span>Tiebreak</span><strong>${winner.tiebreakerDiff} yards</strong></div>
    </div>
  </section>`;
}

function shareHtml(data, winner) {
  return `<section class="section share-section">
    <div class="section-heading"><div><h2>Share this winner page</h2><p>This link is permanent, so ${escapeHtml(winner.name)} can come back to Week ${data.week} any time.</p></div></div>
    <div class="hero-actions"><button id="share-winner" class="button primary" type="button">Share this winner page</button><button id="copy-winner" class="button" type="button">Copy link</button></div>
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
    computeFrameDelays();
    raceFrame = Math.max(0, raceFrames.length - 1);
    app.innerHTML = [
      heroHtml(recapData, winner),
      confirmationHtml(recapData, winner),
      tiebreakHtml(recapData, winner),
      standingsHtml(recapData),
      `<div id="live-race">${raceHtml(recapData)}</div>`,
      routeHtml(recapData, winner),
      helpedHtml(winner),
      await archiveHtml(selected),
      shareHtml(recapData, winner),
    ].join("");
    createRaceCharts(recapData, winner);
    bindRaceControls();
    bindLeadershipTooltips();
    bindSharing(recapData, winner);
    updateRaceFrame(raceFrame);
  } catch (error) {
    console.error(error);
    app.innerHTML = `<section class="error-state"><p class="eyebrow">Winner page unavailable</p><h1>This preserved recap could not load.</h1><p>${escapeHtml(error.message)}</p><a class="button primary" href="winner.html">Open the winner archive</a></section>`;
  }
}

render();
