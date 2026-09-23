# FBP notification operations

## Owner subscription report

Run this from the Worker directory while authenticated to Cloudflare:

```powershell
npm run notifications:report
```

The report is private and reads D1 directly. It lists each player or pool-wide subscription, exact destination, verification status, enabled alert types, and update time. Do not publish or paste the report into public issues or logs.

## Missing-picks reminder and email previews

The expandable Email alerts panel is at the bottom of Enter Picks. Email and a canonical roster player name are required. Verification activates the subscription. The missing-picks reminder defaults to 60 minutes and accepts whole minutes from 1 through 240, with linked number and slider controls. It is sent once per week only when the player's card is absent from the authoritative Apps Script current-week feed, not the potentially delayed D1 submission mirror.

The one-minute Worker schedule evaluates alerts at these points (ESPN refreshes remain every five minutes):

- Picks due: at the subscriber's selected lead time before the week's earliest kickoff, skipped after that player submits.
- First place: an observed move from a lower total-wins rank into sole or shared first after play begins. Best Bets count twice; live scores are provisional. A first observation only establishes a baseline. Each later re-entry has its own deduplication key. Emails include Eastern observation time, prior rank, changed matchup scores/ATS sides, personal Best Bet effects, and a timestamped text rank journey. These are observed score changes, not inferred play-by-play. No embedded graph is generated.
- Early games: after every Sunday game starting before 4 PM Eastern is final.
- Before Sunday Night Football: after the Sunday afternoon games are final and SNF is within 35 minutes, only for players with a path to first or tied first.
- Before Monday Night Football: when MNF is within 35 minutes, only for players still in contention. Night emails enumerate exact remaining ATS combinations (up to eight unresolved games), show up to twelve examples, and distinguish outright first from a tiebreak-dependent finish. Scenario counts are not probabilities.
- Weekly result: after the week is finalized.

Checks run every minute, but scheduling, source refreshes, and mail delivery can delay an alert. A one-minute reminder is best effort, not a guaranteed last-minute delivery. Unknown game states, incomplete cards, a wrong week, a source outage, or a slate differing from the owner-approved locked slate withhold alerts. No stale fallback sends missing-picks alerts. A database lease prevents overlapping scheduled dispatches. Apply migration 0006 before deploying this Worker.

Every alert has styled Open FBP and Stop notifications buttons plus a plain-text fallback. Email buttons use anchors for email-client compatibility. The new signup offers the five requested choices: locked spreads, missing picks, first-place jumps, before SNF, and before MNF. Existing early-window and weekly-result preferences remain supported for legacy subscribers; saving the new form replaces those older choices. No subscriber test messages are sent as part of automated tests.

The picks-ready alert is deliberately excluded from the schedule. When Yahoo has every line, the owner receives a private setup-approval email. Its button opens a confirmation page before staging the week. After staging, a second private email asks the owner to review the website; its separately confirmed button synchronizes the staged slate to D1 and dispatches the picks-ready alert exactly once per subscriber. Approval links expire after 72 hours, and the Worker endpoint requires the shared relay secret.

Preview all alert messages without sending:

```powershell
npm run notifications:preview
```

After email relay setup, send the preview set to the owner address by putting the relay URL and secret in the current terminal environment and running:

```powershell
npm run notifications:preview -- --send --to=fbpool07@gmail.com
```

Do not put the relay secret in command history, source, configuration files, D1, Sheets, browser storage, or chat.

## Email configuration

Email delivery uses the existing Apps Script account as a relay. The same long random secret must be stored in both places:

1. Apps Script project settings: add script property `FBP_NOTIFICATION_RELAY_SECRET`.
2. Cloudflare Worker: run `wrangler secret put EMAIL_RELAY_SECRET` and type the value directly into the terminal prompt.
3. Configure the deployed Apps Script web-app URL as Worker variable `EMAIL_RELAY_URL`.
4. Deploy the Apps Script source and Worker, then complete a real inbox verification test.

Never put the relay secret in source, `wrangler.toml`, D1, Sheets, browser storage, or chat.

## Twilio signup and SMS activation

SMS is intentionally disabled until these steps are complete:

1. Create an account at `https://www.twilio.com/try-twilio` and verify the account email and an existing mobile number.
2. Enable two-factor authentication on the Twilio account.
3. In the Twilio Console, buy an SMS-capable U.S. number. A trial account can send only to verified recipient numbers and adds a trial notice.
4. Create a Messaging Service and attach the purchased number.
5. For normal U.S. production traffic, complete the required A2P 10DLC brand and campaign registration. Twilio displays current fees and approval requirements in the Console.
6. Enable Twilio Advanced Opt-Out so `STOP`, `START`, and `HELP` receive standard handling.
7. Add an inbound-message webhook before launch so opt-outs also update `notification_subscriptions` in D1.
8. Store `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` as Cloudflare Worker secrets. Type each value directly into Wrangler's secret prompt; do not send credentials through chat or commit them.
9. Add a delivery-status callback, run one verified test, confirm `STOP` prevents future delivery, and only then enable the text option in the website.

The website does not currently save phone numbers because SMS delivery and opt-out synchronization are not configured.
