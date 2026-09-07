# FBP notification operations

## Owner subscription report

Run this from the Worker directory while authenticated to Cloudflare:

```powershell
npm run notifications:report
```

The report is private and reads D1 directly. It lists each player or pool-wide subscription, exact destination, verification status, enabled alert types, and update time. Do not publish or paste the report into public issues or logs.

## Missing-picks reminder and email previews

Player subscriptions include a missing-picks reminder. It defaults to one hour before the first kickoff and can be set from 5 through 300 minutes. The reminder is sent once per week only when the followed player's active card is absent.

The five-minute Worker schedule evaluates alerts at these points:

- Picks ready: once all games and point spreads are posted and locked.
- Picks due: at the subscriber's selected lead time before the week's earliest kickoff, skipped after that player submits.
- First place: the first check where the followed player is ranked first after play begins.
- Early games: after every Sunday game starting before 4 PM Eastern is final.
- Before Sunday Night Football: after the Sunday afternoon games are final and SNF is within 35 minutes. This replaces the former separate late-games alert.
- Before Monday Night Football: when MNF is within 35 minutes.
- Weekly result: after the week is finalized.

Because checks run every five minutes, delivery can occur up to about five minutes after a condition becomes true.

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
