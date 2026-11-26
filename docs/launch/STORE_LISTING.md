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

Based on what the code does after the November 2026 security pass. The app is local-first: items live on the device. Nothing below leaves the device unless the person turns the feature on. The iOS privacy manifest is `ios/App/App/PrivacyInfo.xcprivacy`; keep it in step with this page.

| What | When | Purpose | Shared with others? |
| --- | --- | --- | --- |
| Email address (and optional name) | Only if you sign in | Account, sign-in links, reminders | No. Delivered through the SMTP provider acting for Due. |
| 18+ declaration and the privacy-notice version | At sign-in | Legal record (DPDP Act s.9) | No. |
| Backup copy of your items (amounts, dates, providers, notes) | Only if you sign in **and** turn on backup (recorded consent) | Sync across devices | No. Stored encrypted. Daily balances, statement lines and recurring-line detail stay on the device unless you opt in. |
| Gmail messages matching billing searches (read-only) | Only if you connect Gmail | Extract merchant, amount, date for your approval | No. Not used for ads (Google Limited Use). |
| Emails you forward to your Due address | Only if you forward (recorded consent) | Same | No. Held encrypted until parsed (max 24 h); redacted text kept 7 days. |
| Usage events (for example "first item added") | **Off by default**; only if you turn them on (and, when signed in, give the analytics consent) | Improve the product | No. Allow-listed names, no amounts or text. Deleted with the account and after 13 months. |
| Offer-matching query (provider, service type, price) | When you check offers | Show documented benefits | No. Sent in the request body, never stored or logged. |
| Research label (a known provider name only) | When a known provider has no savings guide yet | Add guides | No. Free text you typed is never sent. |
| Plan and subscription records (plan, period, status, amounts, gateway reference) | Only if you buy a paid plan (web checkout) | Billing, invoices, tax records | Payment gateway (Razorpay / Cashfree) processes the payment. Kept 8 years where tax law requires. |
| Phone number | Asked by the payment gateway at checkout | Payment and its receipts | Gateway; Due stores it only if the gateway returns it with the subscription. |
| Error reports | Optional (only if error tracking is configured) | Fix crashes | Scrubbed before sending (no bodies, emails, amounts). |

Never collected: card numbers, UPI PINs, bank passwords, PAN, Aadhaar, OTPs, SMS inbox, contacts, location, photos (documents are read on the device), precise device identifiers, advertising ID. Payments: the payment gateway processes card/UPI details; Due never sees them.

### Google Play Data safety form

- Does your app collect or share any of the required user data types? **Yes, collects** (all optional). **Shares: No** (service providers acting for Due are not "sharing").
- Is all collected data encrypted in transit? **Yes** (HTTPS only; the native app has a CSP that allows only the Due API).
- Do you provide a way for users to request that their data is deleted? **Yes**: in-app account deletion (Account > Your account data) and a web deletion policy under Legal > Deletion.
- Data types, each "Collected, not shared, optional, processed ephemerally: No":
  - Personal info > **Email address**: App functionality, Account management.
  - Financial info > **Other financial info** (user-entered bills, backup only): App functionality.
  - Messages > **Emails** (Gmail / forwarding only): App functionality.
  - App activity > **App interactions** (opt-in analytics): Analytics.
  - Financial info > **Purchase history** (paid plans): App functionality, account management.
  - Personal info > **Phone number** (payment gateway at checkout): App functionality.
- Not collected: location, contacts, photos/videos, files and docs (read on device), audio, health, device or other IDs, web browsing, app info and performance (crash logs are server-side only).
- Financial features declaration: tracks bills and reminders; **no** lending, payments, loan offers or credit decisions.
- Gmail restricted scopes: complete the Google verification first (`docs/production/GOOGLE_VERIFICATION.md`).

### Apple App Privacy ("nutrition label")

- Tracking: **No** (`NSPrivacyTracking` false, no tracking domains, no ATT prompt).
- Data Linked to You (all for App Functionality, except as noted): Contact Info > **Email Address**, **Phone Number**; Financial Info > **Other Financial Info**; Purchases > **Purchase History**; User Content > **Emails or Text Messages**, **Other User Content**; Usage Data > **Product Interaction** (Analytics, only when the person opts in).
- Data Not Linked to You: none (signed-out usage events are only sent after opt-in and carry a random device-local id; declare them as linked to stay conservative).
- Required-reason APIs declared in the manifest: UserDefaults (CA92.1), file timestamps (C617.1, 3B52.1).
- Age rating: 17+ is not required, but the app is for adults: sign-in asks for an 18+ declaration.

Before submitting: confirm these answers against the real production configuration (which integrations are live) and the published Privacy notice.
