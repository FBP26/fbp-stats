const recipient = process.argv.find(argument => argument.startsWith("--to="))?.slice(5) || "fbpool07@gmail.com";
const shouldSend = process.argv.includes("--send");
const siteUrl = "https://fbp26.github.io/fbp-stats/";
const stopUrl = "https://fbp-api.fbp-api-worker.workers.dev/?action=unsubscribe-notifications&token=EXAMPLE";
const standings = "Current weekly standings\n1. Jim — 11-4\n2. Brianna — 10-5\n3. Gary — 9-6\n4. Bo — 8-7";
const timing = {
  picksReady: "Why you received this now: all games and point spreads have been posted and locked. Notifications are checked every 5 minutes.",
  picksDue: "Why you received this now: the first kickoff is about 60 minutes away and your picks are not in. Notifications are checked every 5 minutes.",
  firstPlace: "Why you received this now: the latest Current Week standings first show you in 1st place. Notifications are checked every 5 minutes.",
  earlyWindow: "Why you received this now: all Sunday 1 PM games are final. Notifications are checked every 5 minutes.",
  beforeSnf: "Why you received this now: the Sunday afternoon games are final and Sunday Night Football starts within 35 minutes. Notifications are checked every 5 minutes.",
  beforeMnf: "Why you received this now: Monday Night Football starts within 35 minutes. Notifications are checked every 5 minutes.",
  weeklyResult: "Why you received this now: the week has been finalized. Notifications are checked every 5 minutes.",
};
const messages = [
  ["Picks are ready", "16 games and their point spreads are posted for Week 1 and will not change.", timing.picksReady],
  ["Picks due reminder", "Jim, your Week 1 picks are not in yet.\n\nFirst kickoff: Wednesday, Sep 9, 8:20 PM EDT\nSubmit before kickoff to avoid missing the opening game.", timing.picksDue],
  ["First-place update", standings, timing.firstPlace],
  ["Early games complete", standings, timing.earlyWindow],
  ["Before Sunday Night Football", standings, timing.beforeSnf],
  ["Before Monday Night Football", standings, timing.beforeMnf],
  ["Weekly result", standings, timing.weeklyResult],
].map(([label, summary, timingExplanation]) => ({
  subject: `FBP Week 1: ${label}`,
  body: `${label}\n\n${summary}\n\n${timingExplanation}\n\nOpen FBP: ${siteUrl}\n\nStop all FBP alerts: ${stopUrl}`,
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
