# Store listing: Google Play and Apple App Store

Draft copy for the free public beta. No guaranteed or minimum-saving wording anywhere. Re-check every claim against the app before submitting.

## Developer account (decision)

Publish as an **organisation**: Due is a KarigarAI product commercialised by **Safco Skill Academy Private Limited**, which owns and operates the KarigarAI brand (karigarai.com).

- Developer name on both stores: **Safco Skill Academy Pvt Ltd**. App name: **Due by KAI**.
- Google Play: create an *organisation* developer account in the company's name (needs the company's D-U-N-S number, a company email and a verified phone; verification can take days).
- Apple: the Apple Developer Program as an organisation needs a free D-U-N-S number for the company (request it from Dun & Bradstreet India; allow 1 to 2 weeks), the legal entity name, and an authorised signatory. Apple then verifies the company; allow extra days.
- Start the D-U-N-S request now; it is the longest wait.
- Faster fallback (only if the weekend deadline matters more than the brand name): register an individual account first and transfer the app to the company account later (both stores support app transfer). The store would then show the individual's name as the developer until the transfer, so prefer the organisation route.
- Check each store's current requirements when you register; they change.

## Basics

| Field | Value |
| --- | --- |
| App name | Due by KAI |
| Subtitle (App Store, 30 chars max) | Same life. Smaller bills. (25) |
| Short description (Play, 80 chars max) | Track bills, subscriptions and EMIs. Same life. Smaller bills. (62) |
| Category | Finance |
| Price | Free (free during beta; see `docs/launch/PRICING.md`) |
| Languages | English (India) |
| Developer / seller name | Safco Skill Academy Pvt Ltd |
| Support email | saas@karigarai.com (change to a support alias later) |
| Privacy policy URL | `https://due.karigarai.com/#/legal/privacy` (placeholder: the app's /legal page; fill the legal details in Admin first) |
| Terms URL | `https://due.karigarai.com/#/legal/terms` |
| Website | `https://due.karigarai.com` |
| Age rating | 4+ / Everyone (no user-generated content shared with others; confirm in the questionnaire) |

## Long description (both stores)

Same life. Smaller bills.

Due keeps every bill, subscription and EMI in one place, reminds you before money leaves your account, and shows where you may be overpaying, so you can decide what to do.

FREE DURING BETA. Plus features are free while Due is in public beta. Nothing is charged.

What you can do
- See what is due in the next 7 and 30 days.
- Add bills yourself, or upload a statement, bill or receipt and check every field before anything is saved.
- Get reminders before renewals, EMIs and card dues.
- Spot repeated or forgotten subscriptions and read the provider's own page before you act.
- Export your data any time as CSV, or delete everything.

Your data, your call
- Your statements are read on your phone. Documents you upload are read on your device; the file itself is not sent to Due.
- Optional sign-in lets you back up and use Due on more than one device.
- Connecting Gmail or forwarding emails is optional. Due reads only what you choose, and every field is shown for approval.

Due is information only. It never pays, cancels, switches or recharges anything for you, and it is not a bank, lender or payment app. Totals are estimates based on what you enter; check amounts and dates with your provider.

## Keywords (App Store, 100 chars max)

`bills,subscription,EMI,reminder,due date,renewal,budget,loan,credit card,recharge,expense,India` (96)

## Screenshots to prepare (Founder or Claude)

Home with tiles, an upload review card, Plans screen showing "Free during beta", reminder email. Use fictional data only, never real statements.

## Data safety (Google Play) and App Privacy (Apple)

Based on what the code actually does: the app is local-first. Items live in the browser or app on the device. Only these things reach the server:

| What | When | Purpose | Shared with others? |
| --- | --- | --- | --- |
| Email address (and optional name) | Only if you sign in | Account, sign-in links, reminders | No. Email is delivered through Google Workspace SMTP. |
| Backup copy of your items (amounts, dates, providers, notes) | Only if you sign in and leave backup on | Sync across devices | No. Hosted on Render in a Postgres database. |
| Gmail messages matching billing searches (read-only) | Only if you connect Gmail | Extract merchant, amount, date for your approval | No. Not used for ads. |
| Emails you forward to your Due address | Only if you forward | Same | No. Raw message kept for a short retention period, then deleted. |
| Anonymous usage events (for example "first item added") | Unless you turn them off in Settings | Improve the product | No. Allow-listed, no names, amounts or text. |
| Offer-matching query (provider name and category only) | When you check offers | Show documented benefits | No. No amounts or account details are sent. |
| Error reports | Optional (only if error tracking is configured) | Fix crashes | Scrubbed before sending. |

Never collected: card numbers, UPI PINs, bank passwords, PAN, Aadhaar, OTPs, SMS inbox, contacts, location, precise device identifiers, advertising ID. Document text that looks like these is masked on the device. Payments are not taken in the beta; when Razorpay goes live, Razorpay processes card/UPI details and Due never sees them.

Suggested answers:

- Does the app collect or share user data? Collects (optional): yes. Shares with third parties for their own purposes: no. Service providers (hosting, email delivery, Gmail API at the user's request) act on Due's behalf.
- Data types (Play): Personal info > Email address (optional, account); Financial info > Other financial info (user-entered bills, only if backup is on); App activity > In-app actions (anonymous events); Messages > Emails (only if Gmail or forwarding is enabled). Not collected: location, contacts, photos/files stored on server, device IDs, health.
- Is data encrypted in transit? Yes (HTTPS).
- Can users request deletion? Yes: in-app account deletion plus Settings > delete everything; policy under Legal > Deletion.
- Data used for tracking or advertising? No. No ads, no data sale.
- Apple "Data Linked to You": email address; user content (backup); usage data (if signed in). "Data Not Linked to You": anonymous usage events when signed out. No tracking.
- Sensitive: the app handles financial information; the Play "Financial features" declaration applies. State: tracks bills and reminders, no lending, no payments, no loan offers.
- Google also requires a declaration for Gmail restricted scopes (see `docs/production/GOOGLE_VERIFICATION.md`) before Gmail goes live to the public.

Before submitting: confirm these answers against the real production configuration (which integrations are live) and the published Privacy notice.
