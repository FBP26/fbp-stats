const recipient = process.argv.find(argument => argument.startsWith("--to="))?.slice(5) || "fbpool07@gmail.com";
const shouldSend = process.argv.includes("--send");
const siteUrl = "https://fbp26.github.io/fbp-stats/";
const stopUrl = "https://fbp-api.fbp-api-worker.workers.dev/?action=unsubscribe-notifications&token=EXAMPLE";
const playerSummary = "Jim is #1 of 42 at 11-4.\nWin probability: 38.6%\nPaths to victory: 1,284\nGames remaining: 3";
const messages = [
  ["Picks are ready", "The Week 1 slate is open.\n\n16 games are posted and ready for picks."],
  ["Picks due reminder", "Jim, your Week 1 picks are not in yet.\n\nFirst kickoff: Thursday, Sep 10, 8:20 PM EDT\nSubmit before kickoff to avoid missing the opening game."],
  ["First-place update", playerSummary],
  ["Early games complete", playerSummary],
  ["Late games complete", playerSummary],
  ["Before Sunday Night Football", playerSummary],
  ["Before Monday Night Football", playerSummary],
  ["Weekly result", "Jim finished #3 of 42 at 12-5.\nWeek winner: Brianna at 14-3.\nTiebreak difference: 18 yards."],
].map(([label, summary]) => ({
  subject: `FBP Week 1: ${label}`,
  body: `${label}\n\n${summary}\n\nOpen FBP: ${siteUrl}\n\nStop all FBP alerts: ${stopUrl}`,
}));

if (!shouldSend) {
  messages.forEach(message => console.log(`\n${"=".repeat(72)}\nSUBJECT: ${message.subject}\nTO: ${recipient}\n\n${message.body}`));
  console.log("\nPreview only. Add --send after configuring EMAIL_RELAY_URL and EMAIL_RELAY_SECRET in this terminal.");
  process.exit(0);
}

const relayUrl = String(process.env.EMAIL_RELAY_URL || "").trim();
const relaySecret = String(process.env.EMAIL_RELAY_SECRET || "").trim();
if (!relayUrl || !relaySecret) throw new Error("EMAIL_RELAY_URL and EMAIL_RELAY_SECRET are required for --send.");

for (const message of messages) {
  const response = await fetch(relayUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ action: "send-notification-email", secret: relaySecret, to: recipient, ...message }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) throw new Error(`${message.subject} failed: ${result?.error || response.status}`);
  console.log(`Sent: ${message.subject}`);
}
