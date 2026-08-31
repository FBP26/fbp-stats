const recipient = process.argv.find(argument => argument.startsWith("--to="))?.slice(5) || "fbpool07@gmail.com";
const shouldSend = process.argv.includes("--send");
const siteUrl = "https://fbp26.github.io/fbp-stats/";
const slateUrl = "https://script.google.com/macros/s/AKfycbxZUgJm6LstCEomhmrlJYa_nH7tsmxC_4UZwYdroIZbs-PeI6KdPqUZtsF9fZvr_YuNWQ/exec?action=active-week";
const defaultRelayUrl = "https://script.google.com/macros/s/AKfycbxZUgJm6LstCEomhmrlJYa_nH7tsmxC_4UZwYdroIZbs-PeI6KdPqUZtsF9fZvr_YuNWQ/exec";

const slateResponse = await fetch(slateUrl);
const slate = await slateResponse.json().catch(() => null);
if (!slateResponse.ok || slate?.ok !== true) throw new Error(slate?.error || `Could not load the active slate (${slateResponse.status}).`);

const games = Array.isArray(slate.games) ? slate.games : [];
const gamesWithoutSpreads = games.filter(game => !Number.isFinite(Number(game.spread)));
if (!games.length) throw new Error("The active slate has no games.");
if (gamesWithoutSpreads.length) throw new Error(`${gamesWithoutSpreads.length} active-slate games do not have point spreads.`);

const gameLines = games.flatMap((game, index) => {
  const kickoff = String(game.kickoff || "");
  const kickoffMatch = kickoff.match(/^(.*?\d+\/\d+)\s+(\d+:\d+\s+[AP]M)$/i);
  const dateTime = kickoffMatch ? `${kickoffMatch[1]} · ${kickoffMatch[2]}` : kickoff;
  return [`${index + 1}. ${game.favorite}   ${Number(game.spread)}   ${game.underdog}`, `   ${dateTime}`, ""];
});
const subject = `FBP Week ${slate.week}: Picks are ready`;
const body = [
  "Picks are ready",
  "",
  `The Week ${slate.week} slate is open. All ${games.length} games and point spreads are posted.`,
  "",
  ...gameLines,
  "",
  `Open FBP: ${siteUrl}`,
].join("\n");

if (!shouldSend) {
  console.log(`SUBJECT: ${subject}\nTO: ${recipient}\n\n${body}`);
  console.log("\nPreview only. Add --send after configuring EMAIL_RELAY_SECRET in this terminal.");
  process.exit(0);
}

const relayUrl = String(process.env.EMAIL_RELAY_URL || defaultRelayUrl).trim();
const relaySecret = String(process.env.EMAIL_RELAY_SECRET || "").trim();
if (!relaySecret) throw new Error("EMAIL_RELAY_SECRET is required for --send.");

const response = await fetch(relayUrl, {
  method: "POST",
  headers: { "Content-Type": "text/plain;charset=UTF-8" },
  body: JSON.stringify({ action: "send-notification-email", secret: relaySecret, to: recipient, subject, body }),
});
const result = await response.json().catch(() => null);
if (!response.ok || result?.ok !== true) throw new Error(`${subject} failed: ${result?.error || response.status}`);
console.log(`Sent: ${subject} to ${recipient}`);