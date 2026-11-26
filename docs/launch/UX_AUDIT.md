# Due by KAI: first-time-user UX audit

Audit date: 26 Nov 2026 (IST). Method: production build served locally, driven with Playwright (chromium headless) at 360x800, 390x844 and 1280x800. Server calls were mocked (Savings catalog from `e2e/fixtures`, account calls returned 401, legal and plans calls were unreachable). Statement text came from `src/lib/savings/__tests__/fixtures` (GPay) and a synthetic autopay bank statement. Screenshots are in `/tmp/claude-0/ux/` (not committed).

Caveat: legal text, plans and the beta badge depend on the server. They were not reachable in this run, so the Privacy page and Plans page were seen in their offline state. That state is itself a finding (issues 9 and 13).

## Personas walked

1. Commuter: 28, Navi Mumbai, Hinglish, Netflix, JioHotstar, Spotify, Zomato, card debt.
2. Small proprietor: business and personal spends (the "Is this your business?" flow).
3. Parent, 55, low tech confidence: judged on the same screens by reading load and tap count.

## Scorecard (0-10)

| Area | Score | One-line reason |
|---|---|---|
| First impression | 6 | Clean and calm, clear tagline, but no picture of the product and no proof anyone uses it. |
| Onboarding | 5 | Two screens of text before any action; start page repeats the hero; 2 of 5 start choices are "Not configured". |
| Clarity | 5 | Good plain-language intent, undermined by "Planned in Nov ₹0", "How sure is the amount?", "Commitment", "Limits", "Seasons". |
| Trust | 6 | Strong "read on your phone" and "never pays" lines. Weak: sources say "Not checked yet", legal page can fail to load, no real-world proof. |
| Value moment | 6 | "₹257/month found" appearing on Home after ONE bill is the best moment in the app. It is buried and the main number beside it says ₹0. |
| Speed | 6 | Add flow is under a minute but the form is 2,377 px tall at 360 px. Statement import is fast, but starts with a paste box. |
| Accessibility | 8 | Axe clean on Home, Add, Savings, Move, Settings, Plans, Compare. 48 px targets. Only contrast at 4.47:1 on small teal links and an icon mismatch. |
| India fit | 5 | ₹ and lakh formatting are good, UPI AutoPay detected, IST used. No Hindi or Marathi, no UPI-app-first intake, no WhatsApp. |
| **Overall** | **5.9** | Careful and honest product. Not yet a product people tell friends about. |

## Step-by-step walk

Time-to-understand (TTU) is an estimate of how long a first-time reader needs to know what to do next.

| Step | TTU | Jargon / confusion | Dead ends / taps | Trust gaps | A11y | India gaps | Delight |
|---|---|---|---|---|---|---|---|
| Landing | ~8 s | "Same life. Smaller bills." is vague; "Open Due" does not say what happens. | CTA says "Open Due" but leads to another page of text, not the app. | No screenshot, no user count, no "free" word. | Footer links 4.47:1 contrast (needs 4.5). | English only. | Honest "Information only" line. |
| Start | ~15 s | "Due will organise it" (fine). Hero repeated from landing. | At 360 px the first choice is below the fold (y≈530). "Forward a subscription email" and "Connect Gmail" show "Not configured": dead ends offered as options. "5 of 5 document uploads left this month" is crammed into a circle and truncated. | Good "No connection needed". | Fine. | No "Import GPay / PhonePe statement" tile, the one thing Indians actually have. | Each tile has a one-line promise. |
| Home (empty) | ~5 s | None. | One CTA. Good. | - | - | - | - |
| Add first bill | ~20 s | "How sure is the amount?", "Entered by me / Confirmed from a bill / An estimate", "Commitment" type, "Plus" badges inside the schedule dropdown. | 2 fields needed but 14+ controls visible; form scrolls 2,377 px. Type chips wrap onto 3 rows. Toast "Added X" overlaps the page header. | "Saved on this device" is good. | Inputs have labels. | "Last day of the month" and "3rd of every month" fit Indian billing. | Live "Next: 3 Dec 2026 · 3 Jan 2027" preview. |
| Home after bill | ~10 s | **"Planned in Nov ₹0"** right under a card saying next due ₹649. It looks broken. "Review / Snooze / Edit" on a bill you just typed in. Tile subtitles truncated with "…" ("Plan your instalme…"). Eight tiles for one bill. | Home is ~2,000 px tall on mobile, with a 25-cell calendar. | - | Tiles OK. | "Good morning" in English only. | "₹257/month found" chip (on 1280 px; on 360 px it is a "Savings" chip with no number). |
| Import statement | ~25 s | "Find repeat payments", "AutoPay mandates", "Statement from: Bank account / Credit card" must be chosen before pasting. Blank gap above "Choose PDF or CSV" (hidden file input reserving space). | GPay statement result: "Repeat payments found 0" then "Use this statement for Savings" with no explanation. A dead end. Zomato food orders offered as "Subscription". | "Read in this browser. Nothing is uploaded." is excellent. | Fine. | Detects UPI AutoPay, GPay layout, SBI card layout. Does not accept PhonePe or Paytm exports as a named option. | 4 repeat payments found in one click. |
| Savings moves | ~10 s | "Moves" is a new word. "Found" vs "Saved". "We're studying these bills" (Netflix, Spotify) reads as "we have nothing for you". | Only 1 move for 4 subscriptions. No explanation why Netflix gave none. | "Reported price, check before switching" is honest but scary. | **"₹257/month" breaks mid-word ("₹257/mo nth") at 360 px.** | Mumbai commute pack exists but is below the fold, collapsed to "Choose a city". | "Switch JioHotstar to the Mobile yearly plan: ₹257/month" is concrete. |
| Move detail | ~10 s | "Likely range ₹257 a month · A few taps" (a range of one number). | "Open JioHotstar" opens the provider site; the user must come back and press "I did this". | Both sources say "Not checked yet". This reads as "we have not verified this". | Sheet focus handled. | Yearly plan needs ₹499 upfront; not stated. | Clear "Due never switches or pays". |
| Business profile question | ~15 s | "proprietorship", "LLP", "Private Limited / OPC", "input tax credit" with no gloss. | 5 answers, then a second step (entity type + GST), per name. 2 questions for one statement. | "Due asks; it never decides" is good. | Cards large. | Good fit: proprietorship on PAN, GST. Very India-specific and unique. | Each answer says what changes in Due. |
| Reminders | ~20 s | "Reminder channel", "Quiet hours and timezone", timezone list includes Dubai, Singapore, London. | Must tick a consent checkbox, then "Turn on reminders". In-app reminders only show "when you open Due" (that is not a reminder). Email requires sign-in. WhatsApp "Not available". | - | Radios fine. | WhatsApp is the India channel and is unavailable. No push, no SMS. | Honest "never sends messages just to bring you back". |
| Settings | ~10 s | "Limits", "Seasons", "How totals work", "More planning tools". Top-right "Settings" button is drawn as a sun (looks like a theme toggle). | Delete is 1 tap + 1 confirm. Good. | Legal route showed "Legal details are being finalised" when the server was unreachable. | Fine. | - | Delete confirmation is plain: "can't be undone". |
| Plans / beta | ~20 s | "Indicative", "Not included yet: not configured" on 4 of 6 Plus features. | Buy needs server. | Plus ₹149/month shown while most Plus features are "not configured". | Fine. | ₹ and INR stated. No UPI/AutoPay payment mention. | "No surprise annual renewals." |
| /compare | ~30 s | Table is 5 columns. On 360 px it is a stacked list. | Competitor cells say "Not stated" on 8 of 9 rows. | **Looks one-sided.** Due scores ✓ on 6 rows, rivals "?" | Axe clean. | Good: names CRED and INDmoney. | "Earns only from users, never from lenders" is a real hook. |

## Top 15 issues, ranked by impact

| # | Screen | Problem | Concrete fix |
|---|---|---|---|
| 1 | Home, after first bill | Headline reads "Planned in Nov ₹0" while the next bill is ₹649 on 3 Dec. First thing a new user sees after investing effort looks like a bug. | If this month is 0, show "Next 30 days ₹649" as the big number. Copy: "Due in the next 30 days: ₹649". |
| 2 | Home / Savings | The best moment ("₹257/month found") is a small chip, and on 360 px it shows only "Savings". | Make it the hero card on Home after the first match: "We found ₹257/month you could save on JioHotstar. See how →". Always show the number on mobile. |
| 3 | Start | The user must pick from 5 tiles, 2 marked "Not configured". No tile for the thing Indians have: a GPay / PhonePe / bank statement. | Hide unconfigured tiles. Add a first tile: "Paste or upload a statement. We find your subscriptions for you." Move "Add manually" to second. |
| 4 | Landing to Start | Two pages of marketing text before the app. "Open Due" does not say what happens next. Hero repeated on /start. | Landing CTA: "Start free, no sign-up". Remove hero from /start; show the choices at the top. |
| 5 | Add form | 14+ controls for a 2-field task; 2,377 px at 360 px. "How sure is the amount?" is jargon. | Show Name, Amount, Next date, Repeat only. Fold the rest under "More". Replace the question with a plain "Is this exact?" toggle, or drop it for first-time users. |
| 6 | Savings moves | Netflix, Spotify returned no move, and the screen says "We're studying these bills". User thinks Due has nothing for them. | Copy: "No cheaper plan found for Netflix and Spotify yet. We'll tell you when one appears." plus "Already on the best price" where true. |
| 7 | Move detail | Both sources say "Not checked yet". Price is "Reported", range is one number. | Show "Price checked on <date>" or hide the source status. Replace "Likely range ₹257 a month" with "₹3,089 a year if you pay ₹499 upfront". State the upfront cost. |
| 8 | Reminders | In-app reminders "shown when you open Due" are not reminders. Need a checkbox consent first. WhatsApp unavailable. | Lead with the Calendar file (.ics) and device notifications (native). Pre-tick the in-app consent. Say honestly: "A web page can't buzz your phone. Add to Google Calendar to get alerts." |
| 9 | Privacy page / Plans | If the server is down, privacy says "Legal details are being finalised". Plus ₹149/month shows 4 of 6 features as "not configured". | Bundle the privacy text in the app so it never fails. Hide unavailable Plus features or label the plan "Coming soon, free during beta". |
| 10 | Savings amount | "₹257/month" wraps mid-word at 360 px in the "Found" tile. | Use `white-space: nowrap` on the figure and put "/month" on its own line. |
| 11 | Statement import | GPay statement returns "Repeat payments found 0" and a confusing button "Use this statement for Savings". Zomato orders are typed "Subscription". | Copy: "We read ₹15,041 of UPI-on-credit-card spends. No repeating subscriptions found. Add a bank statement to find AutoPay." Default Zomato / Swiggy orders to "Bill" or unticked. |
| 12 | Business question | "proprietorship / LLP / OPC / input tax credit" with no gloss, one name at a time. | Add one-line help: "Proprietorship: your own shop, filed on your PAN." Group names: "2 firms found. Which are yours?" with checkboxes. |
| 13 | /compare | Eight of nine rows show "Not stated" for rivals. Looks like marketing, which is the opposite of Due's honesty brand. | Fill with sourced facts or remove rows with no source. Add "Source" links per cell. |
| 14 | Top bar | "Settings" icon is a sun. Looks like a theme toggle. | Use a gear and keep the sun only on a theme toggle in Settings. |
| 15 | Home layout | Eight category tiles with truncated subtitles ("Plan your instalme…"), a 25-cell calendar, and 2,000 px of scroll for one bill. | Show only tiles with data plus "Add something". Collapse the calendar until there are 3+ items. Let tile subtitles wrap. |

## 5 "aha" improvements (tell-a-friend moments)

1. **"Paste your GPay, get your list."** One paste, and in 5 seconds: "You pay ₹1,184/month on 4 subscriptions. Netflix has charged you 3 times." This is the screenshot people send to friends.
2. **A "Subscription roast" share card.** "My phone's subscriptions cost ₹14,208 a year. Due found ₹3,089 to save." A clean image, no names, no merchants unless the user adds them. Respects the privacy line.
3. **A Sunday "this week" message.** One calendar or WhatsApp nudge: "₹4,200 leaves your account this week: Jio ₹749, Card ₹2,100, Spotify ₹119." India's real channel is WhatsApp; until then, a calendar file or native notification.
4. **"Will my salary cover it?"** Ask for the salary date. Show a timeline: "Rent ₹18,000 on the 1st, EMI on the 5th. You're ₹2,300 short on the 5th." That is a value moment no rival (CRED, INDmoney) gives for small recurring bills.
5. **Hinglish mode.** "Is mahine ₹3,400 nikalega." "Netflix: kya aap abhi bhi dekhte ho?" Even a Hinglish toggle on 20 key strings makes it feel built for the user, not translated for them.

## Brutal verdict

1. Honest, calm, private, and accessible. Hard to dislike, but also easy to forget.
2. The first screen after your first bill says "₹0", and the "found ₹257/month" win is hiding in a chip.
3. Too many choices (8 tiles, 5 start paths, 14 form fields) for what is a one-paste product.
4. Server-dependent trust (legal, prices, plans) fails in the exact moments a nervous user checks.
5. Fix issues 1 to 5 and put "paste your UPI statement" first, and this becomes a 7.5. Today it is a 5.9.

## Benchmark: first-run experience vs CRED, INDmoney, Rocket Money

Sourced from public web information (search run 26 Nov 2026). Third-party reviews and older articles were used; flows may have changed.

| | CRED | INDmoney | Rocket Money | Due |
|---|---|---|---|---|
| First step | Phone number + OTP. Cards linked to that number are added automatically, per [BankBazaar](https://www.bankbazaar.com/credit-card/cred-credit-card-bill-payment.html). | Mobile number, then personal details with Aadhaar and PAN for KYC, per [INDmoney](https://www.indmoney.com/features/free-kyc-investment-account). | Create an account and link at least one bank account through Plaid, per [Rocket Money help](https://help.truebill.com/articles/1940551-how-to-get-the-most-out-of-truebill). | Open without sign-in. Add a bill by hand. |
| Time to first value | Cards appear after OTP and per-card verification, per [YourStory](https://yourstory.com/2018/12/app-friday-kunal-shah-cred) (2018, may be outdated). | After KYC and bank linking. No first-value detail found. | Recurring tab filled by scanning linked transactions, per [Penny Hoarder](https://www.thepennyhoarder.com/budgeting/rocket-money-review/). | After one typed bill, or one pasted statement. Fastest to start, slowest to fill. |
| Gate | Credit-score eligibility (750+) per [App Store listing](https://apps.apple.com/in/app/cred-credit-cards-payments/id1428580080); a GrowthX [teardown](https://growthx.club/proof-of-work/fintech/cred/onboarding-project-----cred|666d312d7ef6d393e6e57635) criticises hiding it. | KYC. | Bank link required. Manual add exists. | None. |
| Paywall | None for core. | None for core. | Free finds subscriptions; cancelling needs Premium; negotiation takes a share of savings, per [CNBC Select](https://www.cnbc.com/select/rocket-money-review/). | Plus ₹149/month, mostly not yet built. |
| Trust cue | Brand and OTP on own number. | SEBI-regulated KYC flow. | Plaid "read-only". | "Read on your phone, nothing uploaded". Strongest privacy claim, weakest brand proof. |

What to copy:

- **From CRED:** auto-fill from one identifier. Due's equivalent is one paste, and it should be the first option.
- **From Rocket Money:** a "Recurring" list as the home screen after the first scan, with a total "you pay ₹X a month". Due's Home leads with a calendar instead.
- **From INDmoney:** nothing on onboarding speed (KYC is heavy). Due's no-sign-in start is a real advantage; protect it.
- **From CRED's critique:** state the rules up front. Due should say on the landing "Free in beta. No sign-up. Nothing is paid or switched by Due."

## What I could not verify

- Beta badge, legal text, live plans, and real Savings catalog (server not running). Findings 9 and 13 describe offline behaviour.
- Screen-reader speech (checked with axe and accessible names only, no NVDA/TalkBack).
- PDF and photo upload (not exercised).
- Hindi/regional strings: none exist in the build.
