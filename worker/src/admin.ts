// FBP Admin: Jim's private page for the payout grid and pick corrections.
// Served by the Worker at /admin (separate from the public website). Sign-in is a normal username/password form so
// phone password managers save it; a signed cookie then keeps the phone signed in for about a year.
import {
  addPayoutPlayers, balanceCents, editPayoutCell, ledgerEntries, loadSeasonRows, payoutSeasons, recordPayment, recordPayout,
} from "./payouts";

export interface AdminEnv {
  DB: D1Database;
  FBP_ADMIN_PASSWORD?: string;
  FBP_ADMIN_USERNAME?: string;
}

const SESSION_COOKIE = "fbp_admin";
const SESSION_DAYS = 395;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const encoder = new TextEncoder();
const base64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  view.forEach((byte) => { text += String.fromCharCode(byte); });
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const hmac = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(`fbp-admin-session|${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
};

const sameText = async (left: string, right: string): Promise<boolean> => {
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let index = 0; index < x.length; index += 1) diff |= x[index] ^ y[index];
  return diff === 0 && left.length === right.length;
};

const username = (env: AdminEnv): string => (env.FBP_ADMIN_USERNAME || "Jim").trim();

const issueSession = async (env: AdminEnv): Promise<string> => {
  const expires = Date.now() + SESSION_DAYS * 86400000;
  const payload = `${expires}`;
  return `${payload}.${await hmac(String(env.FBP_ADMIN_PASSWORD), payload)}`;
};

const cookieValue = (request: Request, name: string): string => {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
};

const validSession = async (request: Request, env: AdminEnv): Promise<boolean> => {
  if (!env.FBP_ADMIN_PASSWORD) return false;
  const token = cookieValue(request, SESSION_COOKIE);
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !/^\d+$/.test(payload) || Number(payload) < Date.now()) return false;
  return sameText(signature, await hmac(env.FBP_ADMIN_PASSWORD, payload));
};

const clientKey = (request: Request): string => request.headers.get("CF-Connecting-IP") || "unknown";

const recentFailures = async (env: AdminEnv, client: string): Promise<number> => {
  const row = await env.DB.prepare("SELECT COUNT(*) AS failures FROM admin_login_failures WHERE client = ? AND failed_at > ?")
    .bind(client, Date.now() - FAILURE_WINDOW_MS).first<{ failures: number }>();
  return Number(row?.failures || 0);
};

const page = (body: string, status = 200, headers: Record<string, string> = {}): Response => new Response(body, {
  status,
  headers: {
    "Content-Type": "text/html;charset=UTF-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
    ...headers,
  },
});

const apiJson = (body: unknown, status = 200): Response => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (character) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>
)[character]);

const loginPage = (message = "", status = 200): Response => page(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>FBP Admin sign in</title>
<meta name="theme-color" content="#0f172a"><meta name="apple-mobile-web-app-capable" content="yes">
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:16px/1.4 system-ui,-apple-system,Segoe UI,Arial,sans-serif}
form{width:min(340px,calc(100vw - 32px));background:#111c33;border:1px solid #334155;border-radius:14px;padding:22px}
h1{margin:0 0 4px;font-size:20px}p{margin:0 0 16px;color:#94a3b8;font-size:14px}label{display:block;margin:12px 0 4px;font-size:13px;color:#cbd5e1}
input{box-sizing:border-box;width:100%;padding:12px;border-radius:9px;border:1px solid #475569;background:#0b1222;color:#f8fafc;font-size:16px}
button{margin-top:18px;width:100%;padding:13px;border:0;border-radius:9px;background:#facc15;color:#111827;font-weight:700;font-size:16px}
.error{color:#fca5a5;margin:10px 0 0}
</style></head><body>
<form method="post" action="/admin/login" autocomplete="on">
<h1>FBP Admin</h1><p>Payouts and pick changes. Only you can sign in here.</p>
<label for="username">Username</label><input id="username" name="username" autocomplete="username" autocapitalize="none" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
</form></body></html>`, status);

const login = async (request: Request, env: AdminEnv): Promise<Response> => {
  if (!env.FBP_ADMIN_PASSWORD) return loginPage("The admin password has not been set up yet.", 503);
  const client = clientKey(request);
  if (await recentFailures(env, client) >= MAX_FAILURES) return loginPage("Too many tries. Wait 15 minutes and try again.", 429);
  const form = await request.formData();
  const user = String(form.get("username") || "").trim();
  const password = String(form.get("password") || "");
  const ok = user.toLowerCase() === username(env).toLowerCase() && await sameText(password, env.FBP_ADMIN_PASSWORD);
  if (!ok) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO admin_login_failures (client, failed_at) VALUES (?, ?)").bind(client, Date.now()),
      env.DB.prepare("DELETE FROM admin_login_failures WHERE failed_at < ?").bind(Date.now() - 86400000),
    ]);
    return loginPage("That username and password didn't match.", 401);
  }
  const token = await issueSession(env);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/admin",
      "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/admin; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
};

const logout = (): Response => new Response(null, {
  status: 303,
  headers: { Location: "/admin", "Set-Cookie": `${SESSION_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, "Cache-Control": "no-store" },
});

// ---------------------------------------------------------------------------------------------------------------
// Picks

const weekList = async (db: D1Database) => (await db.prepare(
  `SELECT id, season, week, phase, status FROM weeks WHERE phase IN ('REGULAR_SEASON', 'PLAYOFFS')
   ORDER BY season DESC, CASE phase WHEN 'PLAYOFFS' THEN 1 ELSE 0 END DESC, week DESC LIMIT 8`,
).all()).results || [];

const weekDetail = async (db: D1Database, weekId: number) => {
  const week = await db.prepare("SELECT id, season, week, phase, status FROM weeks WHERE id = ?").bind(weekId).first();
  if (!week) throw new Error("That week was not found.");
  const games = (await db.prepare(
    "SELECT id, game_index, favorite, underdog, spread, home_team, away_team, kickoff_at FROM games WHERE week_id = ? ORDER BY game_index",
  ).bind(weekId).all()).results || [];
  const submissions = (await db.prepare(
    `SELECT s.id, p.canonical_name AS name, s.week_name, s.best_bet_game_index, s.tiebreaker, s.submitted_at
     FROM submissions s JOIN players p ON p.id = s.player_id
     WHERE s.week_id = ? AND s.superseded_at IS NULL ORDER BY p.canonical_name COLLATE NOCASE`,
  ).bind(weekId).all()).results || [];
  const picks = (await db.prepare(
    `SELECT sp.submission_id, g.game_index, sp.picked_team FROM submission_picks sp JOIN games g ON g.id = sp.game_id
     JOIN submissions s ON s.id = sp.submission_id WHERE s.week_id = ? AND s.superseded_at IS NULL`,
  ).bind(weekId).all<{ submission_id: number; game_index: number; picked_team: string }>()).results || [];
  const bySubmission = new Map<number, string[]>();
  picks.forEach((pick) => {
    const list = bySubmission.get(pick.submission_id) || Array(games.length).fill("");
    list[pick.game_index] = pick.picked_team;
    bySubmission.set(pick.submission_id, list);
  });
  return {
    week,
    locked: String(week.status) === "finalized",
    games,
    submissions: submissions.map((submission) => ({ ...submission, picks: bySubmission.get(Number(submission.id)) || [] })),
  };
};

const updateSubmission = async (db: D1Database, payload: Record<string, unknown>) => {
  const submissionId = Number(payload.submissionId);
  const submission = await db.prepare(
    `SELECT s.id, s.week_id, s.week_name, s.best_bet_game_index, s.tiebreaker, w.status, p.canonical_name AS name, w.week
     FROM submissions s JOIN weeks w ON w.id = s.week_id JOIN players p ON p.id = s.player_id
     WHERE s.id = ? AND s.superseded_at IS NULL`,
  ).bind(submissionId).first<{ id: number; week_id: number; week_name: string; best_bet_game_index: number; tiebreaker: number; status: string; name: string; week: number }>();
  if (!submission) throw new Error("That entry was not found (it may have been replaced by a newer submission).");
  if (submission.status === "finalized") throw new Error(`Week ${submission.week} is final and its results are archived, so picks can't be changed here.`);
  const games = (await db.prepare("SELECT id, game_index, favorite, underdog FROM games WHERE week_id = ? ORDER BY game_index")
    .bind(submission.week_id).all<{ id: number; game_index: number; favorite: string; underdog: string }>()).results || [];
  const current = (await db.prepare("SELECT game_id, picked_team FROM submission_picks WHERE submission_id = ?")
    .bind(submissionId).all<{ game_id: number; picked_team: string }>()).results || [];
  const currentByGame = new Map(current.map((pick) => [pick.game_id, pick.picked_team]));
  const statements: D1PreparedStatement[] = [];
  const changes: string[] = [];
  const log = (field: string, oldValue: unknown, newValue: unknown) => {
    statements.push(db.prepare("INSERT INTO submission_corrections (submission_id, field, old_value, new_value, reason) VALUES (?, ?, ?, ?, 'FBP Admin')")
      .bind(submissionId, field, String(oldValue ?? ""), String(newValue ?? "")));
  };
  const finalPicks = new Map(games.map((game) => [game.game_index, currentByGame.get(game.id) || ""]));
  const requested = (payload.picks && typeof payload.picks === "object") ? payload.picks as Record<string, unknown> : {};
  for (const [indexText, teamValue] of Object.entries(requested)) {
    const game = games.find((item) => item.game_index === Number(indexText));
    const team = String(teamValue || "").trim().toUpperCase();
    if (!game) throw new Error(`Game ${Number(indexText) + 1} is not in this week.`);
    if (team !== game.favorite.toUpperCase() && team !== game.underdog.toUpperCase()) throw new Error(`${team} is not playing in game ${game.game_index + 1}.`);
    const old = currentByGame.get(game.id) || "";
    if (old.toUpperCase() === team) continue;
    statements.push(currentByGame.has(game.id)
      ? db.prepare("UPDATE submission_picks SET picked_team = ? WHERE submission_id = ? AND game_id = ?").bind(team, submissionId, game.id)
      : db.prepare("INSERT INTO submission_picks (submission_id, game_id, picked_team) VALUES (?, ?, ?)").bind(submissionId, game.id, team));
    log(`pick${game.game_index + 1}`, old, team);
    changes.push(`Game ${game.game_index + 1}: ${old || "none"} → ${team}`);
    finalPicks.set(game.game_index, team);
  }
  let bestIndex = Number(submission.best_bet_game_index);
  if (payload.bestBetGameIndex !== undefined && Number(payload.bestBetGameIndex) !== bestIndex) {
    const next = Number(payload.bestBetGameIndex);
    if (!games.some((game) => game.game_index === next)) throw new Error("The Best Bet has to be one of this week's games.");
    log("bestBet", `${finalPicks.get(bestIndex) || ""} (game ${bestIndex + 1})`, `${finalPicks.get(next) || ""} (game ${next + 1})`);
    changes.push(`Best Bet: game ${bestIndex + 1} → game ${next + 1}`);
    bestIndex = next;
  }
  statements.push(db.prepare("UPDATE submissions SET best_bet_game_index = ?, best_bet_team = ? WHERE id = ?")
    .bind(bestIndex, finalPicks.get(bestIndex) || null, submissionId));
  if (payload.tiebreaker !== undefined && Number(payload.tiebreaker) !== Number(submission.tiebreaker)) {
    const tiebreaker = Number(payload.tiebreaker);
    if (!Number.isFinite(tiebreaker) || tiebreaker < -100 || tiebreaker > 1200) throw new Error("The tiebreaker has to be a number from -100 to 1200.");
    statements.push(db.prepare("UPDATE submissions SET tiebreaker = ? WHERE id = ?").bind(tiebreaker, submissionId));
    log("tiebreaker", submission.tiebreaker, tiebreaker);
    changes.push(`Tiebreaker: ${submission.tiebreaker} → ${tiebreaker}`);
  }
  if (payload.weekName !== undefined) {
    const weekName = String(payload.weekName || "").trim().replace(/\s+/g, " ").slice(0, 200);
    if (weekName !== submission.week_name) {
      statements.push(db.prepare("UPDATE submissions SET week_name = ? WHERE id = ?").bind(weekName, submissionId));
      log("weekName", submission.week_name, weekName);
      changes.push("Week name updated");
    }
  }
  if (!changes.length) return { name: submission.name, changes };
  await db.batch(statements);
  return { name: submission.name, changes };
};

// ---------------------------------------------------------------------------------------------------------------
// Routing

export const handleAdmin = async (request: Request, env: AdminEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) return null;
  if (url.pathname === "/admin/login" && request.method === "POST") return login(request, env);
  if (url.pathname === "/admin/logout") return logout();
  const signedIn = await validSession(request, env);
  if (url.pathname === "/admin" || url.pathname === "/admin/") return signedIn ? page(ADMIN_APP) : loginPage();
  if (!url.pathname.startsWith("/admin/api/")) return apiJson({ ok: false, error: "Not found." }, 404);
  if (!signedIn) return apiJson({ ok: false, error: "Sign in again.", signIn: true }, 401);
  if (request.method === "POST" && request.headers.get("X-FBP-Admin") !== "1") return apiJson({ ok: false, error: "Missing admin header." }, 403);
  try {
    const route = url.pathname.slice("/admin/api/".length);
    const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
    const season = Number(url.searchParams.get("season") || body.season);
    const cents = (value: unknown) => Math.round(Number(String(value ?? "").replace(/[$,]/g, "")) * 100);
    if (route === "payouts" && request.method === "GET") {
      const seasons = await payoutSeasons(env.DB);
      const chosen = Number.isInteger(season) && seasons.includes(season) ? season : seasons[0];
      return apiJson({ ok: true, seasons, season: chosen, rows: chosen ? await loadSeasonRows(env.DB, chosen) : [] });
    }
    if (route === "payouts/cell") return apiJson({ ok: true, result: await editPayoutCell(env.DB, { season, player: String(body.player || ""), column: String(body.column || ""), value: String(body.value ?? ""), adjustBalance: body.adjustBalance !== false, note: String(body.note || "") }) });
    if (route === "payouts/payment") return apiJson({ ok: true, result: await recordPayment(env.DB, { season, player: String(body.player || ""), amountCents: cents(body.amount), note: String(body.note || "") }) });
    if (route === "payouts/payout") return apiJson({ ok: true, result: await recordPayout(env.DB, { season, player: String(body.player || ""), amountCents: cents(body.amount), note: String(body.note || "") }) });
    if (route === "payouts/player") {
      const name = String(body.name || "").trim().replace(/\s+/g, " ");
      if (!name || name.length > 60) throw new Error("Enter the player's name (60 characters or fewer).");
      const added = await addPayoutPlayers(env.DB, season, [name], "Added in FBP Admin.");
      if (!added.length) throw new Error(`${name} is already in the ${season} grid.`);
      const opening = String(body.balance || "").trim();
      if (opening && balanceCents(opening) !== 0) await editPayoutCell(env.DB, { season, player: name, column: "Balance", value: opening, note: "Opening balance." });
      return apiJson({ ok: true, added });
    }
    if (route === "ledger") return apiJson({ ok: true, entries: await ledgerEntries(env.DB, season, url.searchParams.get("player") || "", 300) });
    if (route === "weeks") return apiJson({ ok: true, weeks: await weekList(env.DB) });
    if (route === "week") return apiJson({ ok: true, ...(await weekDetail(env.DB, Number(url.searchParams.get("id")))) });
    if (route === "submission") return apiJson({ ok: true, result: await updateSubmission(env.DB, body) });
    return apiJson({ ok: false, error: "Not found." }, 404);
  } catch (error) {
    return apiJson({ ok: false, error: error instanceof Error ? error.message : "Something went wrong." }, 400);
  }
};

// ---------------------------------------------------------------------------------------------------------------
// The admin app (one page, phone-first).

const ADMIN_APP = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>FBP Admin</title><meta name="theme-color" content="#0f172a"><meta name="apple-mobile-web-app-capable" content="yes">
<style>
:root{color-scheme:dark;--bg:#0f172a;--panel:#111c33;--line:#2b3a55;--text:#e2e8f0;--muted:#94a3b8;--gold:#facc15;--owe:#fca5a5;--credit:#86efac;--paid:#93c5fd;--win:#fde68a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.35 system-ui,-apple-system,Segoe UI,Arial,sans-serif}
header{position:sticky;top:0;z-index:5;display:flex;gap:8px;align-items:center;padding:10px 12px;background:#0b1222;border-bottom:1px solid var(--line)}
header h1{font-size:16px;margin:0 auto 0 0}nav{display:flex;gap:6px}
nav button,.chip{border:1px solid var(--line);background:var(--panel);color:var(--text);padding:8px 12px;border-radius:999px;font-size:14px}
nav button[aria-current=true]{background:var(--gold);color:#111827;border-color:var(--gold);font-weight:700}
main{padding:12px}.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 10px}
select,input,textarea{background:#0b1222;color:var(--text);border:1px solid #475569;border-radius:9px;padding:9px 10px;font-size:16px}
.muted{color:var(--muted);font-size:13px}.scroll{overflow:auto;border:1px solid var(--line);border-radius:10px;max-height:calc(100vh - 150px)}
table{border-collapse:separate;border-spacing:0;font-size:14px}th,td{padding:7px 8px;border-bottom:1px solid var(--line);border-right:1px solid #1e2a42;text-align:center;white-space:nowrap}
thead th{position:sticky;top:0;background:#0b1222;z-index:2}th:first-child,td:first-child{position:sticky;left:0;background:var(--panel);text-align:left;z-index:1}
thead th:first-child{z-index:3}tbody tr:nth-child(even) td{background:#0f1a30}tbody tr:nth-child(even) td:first-child{background:#13203b}
td.cell{cursor:pointer;min-width:44px}td.cell:active{outline:2px solid var(--gold)}
.v-owe{color:var(--owe);font-weight:700}.v-paid{color:var(--paid)}.v-win{color:var(--win);font-weight:700}.v-credit{color:var(--credit);font-weight:700}
tr.fixed td{color:var(--muted);font-style:italic}td.bal{font-weight:700}
.sheet{position:fixed;inset:auto 0 0 0;z-index:20;background:#0b1222;border-top:2px solid var(--gold);border-radius:16px 16px 0 0;padding:14px 14px calc(14px + env(safe-area-inset-bottom));max-height:85vh;overflow:auto;box-shadow:0 -10px 30px #0008}
.sheet h2{margin:0 0 2px;font-size:17px}.row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.btn{border:1px solid var(--line);background:var(--panel);color:var(--text);padding:11px 14px;border-radius:10px;font-size:15px}
.btn.primary{background:var(--gold);color:#111827;border-color:var(--gold);font-weight:700}.btn.danger{border-color:#7f1d1d;color:#fecaca}
.btn.sel{outline:2px solid var(--gold)}.grow{flex:1}.full{width:100%}
.toast{position:fixed;left:50%;top:60px;transform:translateX(-50%);z-index:30;background:#14532d;color:#dcfce7;padding:10px 14px;border-radius:10px;max-width:92vw;box-shadow:0 6px 20px #0008}
.toast.err{background:#7f1d1d;color:#fee2e2}
.players{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px;text-align:left;color:var(--text);font-size:14px}
.game{display:grid;grid-template-columns:28px 1fr 1fr 44px;gap:6px;align-items:center;margin:6px 0}
.team{padding:11px 6px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--text);font-weight:700}
.team.on{background:#1d4ed8;border-color:#60a5fa}.star{font-size:20px;padding:6px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:#64748b}
.star.on{color:var(--gold);border-color:var(--gold)}.ledger td{text-align:left;white-space:normal;min-width:90px}
.backdrop{position:fixed;inset:0;background:#0007;z-index:15}
</style></head><body>
<header><h1>FBP Admin</h1><nav><button data-tab="payouts" aria-current="true">Payouts</button><button data-tab="picks">Picks</button><button data-tab="ledger">Ledger</button></nav></header>
<main id="main"></main><div id="overlay"></div>
<script>
const state={tab:"payouts",season:null,rows:[],seasons:[],weeks:[],week:null};
const $=s=>document.querySelector(s);const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function api(path,body){const r=await fetch("/admin/api/"+path,body?{method:"POST",headers:{"Content-Type":"application/json","X-FBP-Admin":"1"},body:JSON.stringify(body)}:{});const j=await r.json().catch(()=>({ok:false,error:"Bad response"}));if(j.signIn){location.reload();throw new Error("Signed out");}if(!j.ok)throw new Error(j.error||"Request failed");return j;}
function toast(t,err){document.querySelectorAll(".toast").forEach(x=>x.remove());const d=document.createElement("div");d.className="toast"+(err?" err":"");d.textContent=t;document.body.append(d);setTimeout(()=>d.remove(),err?6000:2500);}
function closeSheet(){$("#overlay").innerHTML="";}
function openSheet(html){$("#overlay").innerHTML='<div class="backdrop" data-close></div><div class="sheet">'+html+'</div>';$("#overlay .backdrop").onclick=closeSheet;}
function cls(v,isBal){const t=String(v||"").trim().toLowerCase();if(isBal){if(!t||t==="even")return"";return t.startsWith("+")?"v-credit":"v-owe";}if(/^\\$?\\d/.test(t))return"v-owe";if(t.startsWith("paid"))return"v-paid";if(t.startsWith("win")||t==="tie")return"v-win";return"";}
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;document.querySelectorAll("nav button").forEach(x=>x.setAttribute("aria-current",x===b));render();});
function render(){if(state.tab==="payouts")return loadPayouts();if(state.tab==="picks")return loadWeeks();return loadLedger();}
/* ---------- payouts ---------- */
async function loadPayouts(season){try{const j=await api("payouts"+(season||state.season?"?season="+(season||state.season):""));Object.assign(state,{seasons:j.seasons,season:j.season,rows:j.rows});drawPayouts();}catch(e){toast(e.message,true);}}
function labels(){return(state.rows.find(r=>r.kind==="periods")||{cells:[]}).cells;}
function balIdx(){const i=labels().findIndex(l=>l.trim().toLowerCase()==="balance");return i<0?19:i;}
function drawPayouts(){const L=labels(),B=balIdx();const order=[B,...L.map((_,i)=>i).filter(i=>i!==B)];const head=order.map(i=>{const l=L[i];return l;}).map((l,k)=>{const i=order[k];return l.trim()?'<th>'+esc(l.trim().toLowerCase()==="playoffs"?"PO":l.trim().toLowerCase()==="balance"?"Bal":l)+'</th>':'';}).join("");
const body=state.rows.filter(r=>["player","champion","total"].includes(r.kind)).map(r=>{const editable=r.kind!=="total";return'<tr class="'+(r.kind==="player"?"":"fixed")+'"><td data-player="'+esc(r.label)+'" data-kind="'+r.kind+'">'+esc(r.label)+'</td>'+order.map(i=>{const l=L[i];return l.trim()?'<td class="'+(editable?"cell ":"")+(i===B?"bal ":"")+cls(r.cells[i],i===B)+'" data-i="'+i+'" data-player="'+esc(r.kind==="champion"?"__champion__":r.label)+'">'+esc(r.cells[i])+'</td>':'';}).join("")+'</tr>';}).join("");
const owed=state.rows.filter(r=>r.kind==="player").reduce((a,r)=>{const t=String(r.cells[B]||"").trim();if(!t||t==="even")return a;const n=Number(t.replace(/[^0-9.]/g,""))||0;t.startsWith("+")?a.credit+=n:a.owed+=n;return a;},{owed:0,credit:0});
$("#main").innerHTML='<div class="bar"><select id="season">'+state.seasons.map(s=>'<option'+(s===state.season?" selected":"")+'>'+s+'</option>').join("")+'</select><button class="chip" id="addp">+ Player</button><span class="muted">Owed to pool $'+owed.owed+' · Owed to players $'+owed.credit+'</span></div><p class="muted" style="margin:0 0 8px">Tap a cell to change it. Tap a name for that player\\'s history.</p><div class="scroll"><table><thead><tr><th>Name</th>'+head+'</tr></thead><tbody>'+body+'</tbody></table></div>';
$("#season").onchange=e=>loadPayouts(e.target.value);$("#addp").onclick=addPlayer;
document.querySelectorAll("td.cell").forEach(td=>td.onclick=()=>editCell(td.dataset.player,Number(td.dataset.i)));
document.querySelectorAll("td[data-kind=player]").forEach(td=>td.onclick=()=>playerHistory(td.dataset.player));}
function editCell(player,i){const L=labels(),B=balIdx();const row=player==="__champion__"?state.rows.find(r=>r.kind==="champion"):state.rows.find(r=>r.kind==="player"&&r.label===player);const cur=row.cells[i];const col=L[i];const name=player==="__champion__"?"Season champion":player;
if(i===B&&player!=="__champion__"){openSheet('<h2>'+esc(name)+' · Balance</h2><p class="muted">Now: <b class="'+cls(cur,true)+'">'+esc(cur||"even")+'</b> — "100" = owes $100, "+100" = you owe them $100.</p>'+
'<div class="row"><input id="amt" inputmode="decimal" placeholder="Amount $" class="grow"><input id="note" placeholder="Note (optional)" class="grow"></div>'+
'<div class="row"><button class="btn primary grow" id="pay">Payment received</button><button class="btn grow" id="out">Paid out to them</button></div>'+
'<p class="muted">Payment received turns their owed weeks to "paid" (oldest first). Paid out lowers their + credit.</p>'+
'<div class="row"><input id="setbal" placeholder="Or type a new balance (even, 40, +120)" class="grow"><button class="btn" id="set">Set</button></div><button class="btn full" data-close>Cancel</button>');
const amount=()=>$("#amt").value;$("#pay").onclick=()=>act("payouts/payment",{season:state.season,player,amount:amount(),note:$("#note").value},r=>name+': payment recorded. Balance '+r.balanceBefore+' → '+r.balanceAfter);
$("#out").onclick=()=>act("payouts/payout",{season:state.season,player,amount:amount(),note:$("#note").value},r=>name+': payout recorded. Balance '+r.balanceBefore+' → '+r.balanceAfter);
$("#set").onclick=()=>act("payouts/cell",{season:state.season,player,column:"Balance",value:$("#setbal").value,note:$("#note").value},r=>name+': balance '+r.balanceBefore+' → '+r.balanceAfter);}
else{const isPO=col.trim().toLowerCase()==="playoffs";const opts=player==="__champion__"?["20","360",""]:["paid","10",isPO?"20":null,"win",""].filter(v=>v!==null);
openSheet('<h2>'+esc(name)+' · '+esc(isPO?"Playoffs":"Week "+col)+'</h2><p class="muted">Now: <b>'+esc(cur||"blank")+'</b></p><div class="row">'+opts.map(o=>'<button class="btn grow'+(o===cur?" sel":"")+'" data-v="'+esc(o)+'">'+esc(o||"blank")+'</button>').join("")+'</div>'+
'<div class="row"><input id="val" value="'+esc(cur)+'" placeholder="Or type a value" class="grow"><button class="btn primary" id="save">Save</button></div>'+
(player==="__champion__"?'':'<label class="muted"><input type="checkbox" id="adj" checked> Update their balance to match (e.g. "10" → "paid" lowers what they owe by $10)</label>')+
'<div class="row"><input id="note" placeholder="Note (optional)" class="grow"></div><button class="btn full" data-close>Cancel</button>');
const save=v=>act("payouts/cell",{season:state.season,player,column:col,value:v,adjustBalance:$("#adj")?$("#adj").checked:false,note:$("#note").value},r=>name+': '+(isPO?"Playoffs":"Week "+col)+' "'+(r.oldValue||"blank")+'" → "'+(r.newValue||"blank")+'"'+(r.balanceAfter&&r.balanceAfter!==r.balanceBefore?'. Balance '+r.balanceBefore+' → '+r.balanceAfter:''));
document.querySelectorAll(".sheet [data-v]").forEach(b=>b.onclick=()=>save(b.dataset.v));$("#save").onclick=()=>save($("#val").value);}
document.querySelectorAll(".sheet [data-close]").forEach(b=>b.onclick=closeSheet);}
async function act(path,body,msg){try{const j=await api(path,body);closeSheet();toast(msg(j.result||{}));await loadPayouts();}catch(e){toast(e.message,true);}}
function addPlayer(){openSheet('<h2>Add a player to '+state.season+'</h2><div class="row"><input id="pn" placeholder="Name" class="grow"></div><div class="row"><input id="pb" placeholder="Starting balance (even, 40, +20)" class="grow"></div><div class="row"><button class="btn primary grow" id="go">Add</button><button class="btn grow" data-close>Cancel</button></div>');
$("#go").onclick=async()=>{try{await api("payouts/player",{season:state.season,name:$("#pn").value,balance:$("#pb").value});closeSheet();toast("Added "+$("#pn").value);loadPayouts();}catch(e){toast(e.message,true);}};document.querySelectorAll(".sheet [data-close]").forEach(b=>b.onclick=closeSheet);}
async function playerHistory(player){try{const j=await api("ledger?season="+state.season+"&player="+encodeURIComponent(player));openSheet('<h2>'+esc(player)+' · '+state.season+' history</h2>'+ledgerTable(j.entries)+'<button class="btn full" data-close>Close</button>');document.querySelectorAll(".sheet [data-close]").forEach(b=>b.onclick=closeSheet);}catch(e){toast(e.message,true);}}
function money(c){const n=Number(c)||0;if(!n)return"";return(n>0?"+":"−")+"$"+(Math.abs(n)/100).toFixed(Math.abs(n)%100?2:0);}
function bal(c){if(c===null||c===undefined)return"";const n=Number(c);if(!n)return"even";return n<0?"+"+(Math.abs(n)/100):""+(n/100);}
function ledgerTable(entries){if(!entries.length)return'<p class="muted">No entries yet.</p>';return'<div class="scroll" style="max-height:60vh"><table class="ledger"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Owes</th><th>Balance</th></tr></thead><tbody>'+entries.map(e=>'<tr><td>'+esc(String(e.recorded_at).replace("T"," ").slice(0,16))+'</td><td>'+esc(e.player)+'</td><td><b>'+esc(String(e.type).replace(/_/g," ").toLowerCase())+'</b>'+(e.period?' · '+esc(e.period):'')+'<br><span class="muted">'+esc(e.notes)+'</span></td><td>'+money(e.balance_change_cents)+'</td><td>'+bal(e.balance_after_cents)+'</td></tr>').join("")+'</tbody></table></div>';}
/* ---------- ledger ---------- */
async function loadLedger(){try{if(!state.season){const p=await api("payouts");state.season=p.season;state.seasons=p.seasons;}const j=await api("ledger?season="+state.season);$("#main").innerHTML='<p class="muted">Latest 300 payout changes for '+state.season+' (newest first).</p>'+ledgerTable(j.entries);}catch(e){toast(e.message,true);}}
/* ---------- picks ---------- */
async function loadWeeks(){try{const j=await api("weeks");state.weeks=j.weeks;if(!state.week)state.week=(j.weeks.find(w=>w.status!=="finalized")||j.weeks[0]||{}).id;await loadWeek();}catch(e){toast(e.message,true);}}
async function loadWeek(){const j=await api("week?id="+state.week);state.detail=j;drawWeek();}
function wLabel(w){return(w.phase==="PLAYOFFS"?"Playoffs ":"Week ")+w.week+" · "+w.status;}
function drawWeek(){const d=state.detail;$("#main").innerHTML='<div class="bar"><select id="wk">'+state.weeks.map(w=>'<option value="'+w.id+'"'+(w.id==state.week?" selected":"")+'>'+esc(wLabel(w))+'</option>').join("")+'</select><input id="q" placeholder="Find a player" class="grow"></div>'+
(d.locked?'<p class="muted">This week is final, so picks are locked. Pick an open week to make changes.</p>':'<p class="muted">'+d.submissions.length+' entries. Tap a player to change picks, Best Bet, tiebreaker or week name.</p>')+'<div class="players" id="pl"></div>';
const drawList=()=>{const q=$("#q").value.trim().toLowerCase();$("#pl").innerHTML=d.submissions.filter(s=>!q||s.name.toLowerCase().includes(q)).map(s=>'<button class="card" data-id="'+s.id+'"><b>'+esc(s.name)+'</b><br><span class="muted">TB '+esc(s.tiebreaker)+' · BB '+esc(s.picks[s.best_bet_game_index]||"")+'</span></button>').join("");document.querySelectorAll("#pl .card").forEach(c=>c.onclick=()=>editEntry(Number(c.dataset.id)));};
$("#wk").onchange=async e=>{state.week=Number(e.target.value);await loadWeek();};$("#q").oninput=drawList;drawList();}
function editEntry(id){const d=state.detail,s=d.submissions.find(x=>x.id===id);const picks=[...s.picks];let best=Number(s.best_bet_game_index);const lock=d.locked;
const draw=()=>{openSheet('<h2>'+esc(s.name)+'</h2><p class="muted">'+(lock?"Final week — view only.":"Tap a team to change the pick. ★ = Best Bet.")+'</p>'+d.games.map(g=>{const fav=g.favorite,dog=g.underdog;return'<div class="game"><span class="muted">'+(g.game_index+1)+'</span><button class="team'+(picks[g.game_index]===fav?" on":"")+'" data-g="'+g.game_index+'" data-t="'+esc(fav)+'"'+(lock?" disabled":"")+'>'+esc(fav)+' −'+esc(g.spread)+'</button><button class="team'+(picks[g.game_index]===dog?" on":"")+'" data-g="'+g.game_index+'" data-t="'+esc(dog)+'"'+(lock?" disabled":"")+'>'+esc(dog)+'</button><button class="star'+(best===g.game_index?" on":"")+'" data-b="'+g.game_index+'"'+(lock?" disabled":"")+'>★</button></div>';}).join("")+
'<div class="row"><label class="muted grow">Tiebreaker<br><input id="tb" inputmode="numeric" value="'+esc(tbv)+'" class="full"'+(lock?" disabled":"")+'></label></div><div class="row"><label class="muted grow">Week name<br><textarea id="wn" rows="2" class="full"'+(lock?" disabled":"")+'>'+esc(wnv)+'</textarea></label></div>'+
'<div class="row">'+(lock?'':'<button class="btn primary grow" id="sv">Save changes</button>')+'<button class="btn grow" data-close>'+(lock?"Close":"Cancel")+'</button></div>');
document.querySelectorAll(".sheet .team").forEach(b=>b.onclick=()=>{picks[Number(b.dataset.g)]=b.dataset.t;keep();draw();});
document.querySelectorAll(".sheet .star").forEach(b=>b.onclick=()=>{best=Number(b.dataset.b);keep();draw();});
document.querySelectorAll(".sheet [data-close]").forEach(b=>b.onclick=closeSheet);
const sv=$("#sv");if(sv)sv.onclick=save;};
let tbv=s.tiebreaker,wnv=s.week_name;const keep=()=>{if($("#tb")){tbv=$("#tb").value;wnv=$("#wn").value;}};
const save=async()=>{keep();const changed={};picks.forEach((p,i)=>{if(p!==s.picks[i])changed[i]=p;});const body={submissionId:id,picks:changed,bestBetGameIndex:best,tiebreaker:Number(tbv),weekName:wnv};
try{const j=await api("submission",body);closeSheet();toast(j.result.changes.length?s.name+": "+j.result.changes.join("; "):"No changes.");await loadWeek();}catch(e){toast(e.message,true);}};
draw();}
render();
</script></body></html>`;
