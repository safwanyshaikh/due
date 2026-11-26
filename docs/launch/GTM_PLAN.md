# Due by KAI: go-to-market plan (Mumbai MMR, free public beta)

Prepared 26 Nov 2026 (IST). Owner: Founder / growth. Status: plan, not yet executed.

Inputs read: `docs/research/value-graph-v2.html`, `docs/launch/COMPETITION.md`, `PRICING.md`, `STORE_LISTING.md`, `docs/production/SAVINGS_SPEC.md`, `README.md`. Competitor and price facts are in `PRICING_RESEARCH.md` with sources.

Honesty rules for every channel (non-negotiable, from the spec and lawyer note in the research page):

- No guarantee, no "minimum saving", no "you will save Rs X" in public copy. The 2x refund idea is an internal measurement design and is NOT advertised.
- Due is information only. It never pays, cancels, pauses, switches, recharges or lends. Do not imply it does.
- Comparative claims: only the "Not stated" / sourced approach already used on `/compare`, dated "as of Nov 2026".
- Never use real customer data, real screenshots of anyone's statements, or real testimonials without written consent. Illustrative examples must be labelled "Illustrative".
- Money shown in the app is "found" (what could be saved) until a receipt proves "saved". Public copy uses "found" language and never promises it.

---

## 1. Positioning

One-liner: **Due reads your statements on your phone, finds what you pay again and again, and shows moves to pay less. Same life, smaller bills.**

Support points (all true to the spec): statement is read on the device; Due earns from its users, not from lenders or merchants; Due shows the move and the official source, you decide; free during public beta.

Category claim to own: "the neutral audit of every recurring rupee" (Due's own positioning from the research page: CRED sells loans via lenders, Due earns nothing from lenders).

## 2. ICP: three personas

| # | Persona | Who | One-line pain | Why Due, first hook |
| --- | --- | --- | --- | --- |
| P1 | Salaried commuter, MMR | 25 to 38, lives Navi Mumbai / Thane / Mira-Bhayander / Kharghar, commutes to BKC / Powai / Lower Parel / Airport area; pays for OTT, phone recharge, card, a bus pass or cab rides, an EMI or two | "I know money leaves my account every month but I can't list where." | Import one statement, see the recurring list in minutes, with the first move |
| P2 | Small-business owner / proprietor | Shop, clinic, agency, trainer, 1 to 15 staff; mixes personal and business spends on one or two accounts | "Tools, SIMs, software and card interest pile up and nobody reviews them." | Business profile separate from personal; recurring vendor and card-interest view; export for the accountant (planned, see PRICING) |
| P3 | Family finance manager | Usually the person who handles household bills for parents, spouse, kids; school fees, insurance, electricity, multiple phones | "Five people, five subscriptions, three due dates, one me." | One view of what is due and what repeats; calm reminders |

Beta priority: P1 first (densest reachable network in MMR, simplest statement), P3 second (WhatsApp family groups spread it), P2 third (higher value per user, needs a tighter message and more trust; start through CA partnerships).

## 3. Funnel definitions

| Stage | Definition | Notes |
| --- | --- | --- |
| Visit | Landing page session on due.karigarai.com | UTM every link: `utm_source=<channel>&utm_medium=<type>&utm_campaign=<name>` |
| Signup | Account created | |
| **Activation** | First statement imported (parsed lines > 0) | Primary growth metric |
| **Aha** | First move shown with a Rs amount found | Rs shown is "found", labelled with source |
| Retained (W4) | Opens app in week 4 after activation | Also track W1, W2, M2 |
| Referral | New user activates via invite link | |
| Found Rs per user | Median and mean monthly Rs found across activated users, from the on-device engine, reported via opt-in anonymous reports only | Never publish per-user numbers; publish only aggregates with n >= 20 (the spec's `COMMUNITY_THRESHOLD`) |

Targets below are hypotheses to be corrected by beta data, not forecasts: signup to activation 40%+; activation to aha 70%+; W4 retention of activated users 30%+. (Hypotheses chosen by judgment, not sourced benchmarks.)

## 4. Channel plan by phase

### Phase A: first 100 users (weeks 1 to 4, founder-led, Rs 0 to Rs 25k)

Goal: 100 activated users from real conversations, 20 in-depth feedback calls, 10 users who will be named in case studies only with written consent.

| Channel | Play | Rules |
| --- | --- | --- |
| Founder's own WhatsApp / contacts in MMR | Personal message to 40 to 60 people in P1 and P3, offering a 15-minute "find your recurring bills" session | Only people who know you. One message, no forwarding chains |
| WhatsApp communities / housing-society groups (MyGate-style) | Ask a society committee member or admin to allow ONE post; offer a 20-minute evening "audit your subscriptions" session at the clubhouse or on a call | Always ask the admin first; many groups ban promotion. Do not scrape numbers, do not add people to groups. See `PARTNERSHIPS.md` |
| Cityflo / office-commute communities | Post in commuter groups the founder is already a member of; offer to speak to a route's group admin | Join as a human, not a marketer. Do not contact via data you obtained from Cityflo. Verify any Cityflo cooperation in writing |
| LinkedIn founder content | 3 posts a week, building in public | No fake numbers; no beta-user data |
| College alumni groups | Founder's alumni WhatsApp / LinkedIn groups; ask for 10 "audit buddies" | Ask a group moderator first |
| CA / tax-consultant partnerships (start) | 5 conversations; offer free Business-profile setup for 3 of their clients | CAs advise clients; Due offers no financial advice. See `PARTNERSHIPS.md` |

### Phase B: 100 to 1,000 users (weeks 5 to 16)

Goal: repeatable loops, 1,000 signups, 400+ activated.

| Channel | Play |
| --- | --- |
| Referral loop (section 6) | Invite link in the post-aha screen |
| Instagram reels | 2 reels a week using the 3 scripts in `CONTENT_PACK.md` and variations; illustrative data only |
| Reddit | r/mumbai, r/IndiaInvestments, r/personalfinanceindia (to verify it exists and its rules): answer questions first, share Due only where rules allow; 9 value comments to 1 mention. Read each sidebar before posting; subs commonly restrict self-promotion. Disclose that you are the founder |
| Society / community talks | One 30-minute "Subscription Sunday" in 4 to 6 societies via committee invitation |
| CA network | Joint webinar with 2 to 3 CAs on "what to review before 31 March" (verify dates with the CA) |
| Coworking spaces / employee-benefit platforms | Run lunch-and-learn; pilot with one employer as a non-commercial wellness session |
| Press | Press note to Indian startup media after 300 to 500 activated users, with a methodology note |

### Phase C: 1,000 to 10,000 users (months 4 to 9)

Goal: a repeatable, measurable acquisition mix and a first paid conversion test of Plus (price hypothesis in `PRICING_RESEARCH.md`).

| Channel | Play |
| --- | --- |
| Employer / society "partners" | 5 to 10 partnerships with recurring sessions (see `PARTNERSHIPS.md`) |
| Paid social (small tests) | Instagram / Meta and Google App campaigns only after activation rate is proven in organic; creative uses only compliant language |
| SEO / blog | "Same life. Smaller bills." plus how-to posts: "how to find recurring payments in a bank statement", "card interest explained", "RBI prepayment rule for floating-rate loans" (cite RBI; as stated in the research page: since 1 Jan 2026 RBI bars prepayment charges on floating-rate loans to individuals; re-verify before publishing) |
| Creator / micro-influencer | Finance and Mumbai-lifestyle creators; paid posts must follow ASCI disclosure guidelines (to verify the current text) |
| App-store optimisation | Store copy in `STORE_LISTING.md`; ratings prompt only after aha |
| Referral | Raise reward cap after unit economics are known |

## 5. Weekly calendar, first 4 weeks (IST)

Week 1 starts Mon 30 Nov 2026. Times are IST. Note Week 4 overlaps the year-end holidays: schedule lighter societal outreach and lean on the "New Year, fewer forgotten subscriptions" content hook (no guarantee wording).

### Week 1 (30 Nov to 6 Dec): seed

| Day | Time | Action |
| --- | --- | --- |
| Mon 30 Nov | 10:00 | Set up UTM sheet, analytics event check (activation, aha), feedback form |
| Mon 30 Nov | 20:00 | LinkedIn post 1: "I audited my own subscriptions" (illustrative or founder's own data, with consent of founder) |
| Tue 1 Dec | 09:00 | 20 personal WhatsApp invites (P1/P3) |
| Wed 2 Dec | 19:00 | 3 onboarding calls (15 min each) |
| Thu 3 Dec | 20:00 | LinkedIn post 2 + Instagram Reel 1 |
| Fri 4 Dec | 18:30 | 20 more WhatsApp invites; ask 3 society admins for permission |
| Sat 5 Dec | 11:00 | Coffee conversation with 1 CA; collect feedback |
| Sun 6 Dec | 18:00 | Review: activation per invite; list top 5 friction points |

### Week 2 (7 to 13 Dec): fix and widen

| Day | Time | Action |
| --- | --- | --- |
| Mon 7 Dec | 10:00 | First monthly competitor check (per `COMPETITION.md`); update `/compare` if needed |
| Mon 7 Dec | 20:00 | LinkedIn post 3: "what 20 people found" only if n and consent allow; otherwise a product lesson |
| Tue 8 Dec | 09:00 | WhatsApp broadcast 1 (opted-in list only) |
| Wed 9 Dec | 19:00 | Alumni-group post (moderator-approved) |
| Thu 10 Dec | 20:00 | Reel 2; reply to every comment within 24 hours |
| Fri 11 Dec | 18:30 | Society talk or call (if approved) |
| Sat 12 Dec | 11:00 | 2 CA meetings |
| Sun 13 Dec | 18:00 | Review metrics; ship top 2 fixes |

### Week 3 (14 to 20 Dec): referral on

| Day | Time | Action |
| --- | --- | --- |
| Mon 14 Dec | 10:00 | Turn on invite link (after aha) |
| Mon 14 Dec | 20:00 | LinkedIn post 4: "how referrals work, and what we do not do" |
| Tue 15 Dec | 09:00 | WhatsApp broadcast 2 (referral) |
| Wed 16 Dec | 19:00 | Reddit: answer 5 questions in r/mumbai and a finance sub (no link unless allowed) |
| Thu 17 Dec | 20:00 | Reel 3 |
| Fri 18 Dec | 18:30 | Commute community post (via admin) |
| Sat 19 Dec | 11:00 | 5 feedback calls |
| Sun 20 Dec | 18:00 | Review: referral conversion; check any unusual claims in replies |

### Week 4 (21 to 27 Dec): year-end hook

| Day | Time | Action |
| --- | --- | --- |
| Mon 21 Dec | 10:00 | Pricing survey (3 questions in `PRICING_RESEARCH.md`) in-app to activated users |
| Mon 21 Dec | 20:00 | LinkedIn post 5: "Year-end: list what you pay again and again" |
| Tue 22 Dec | 09:00 | WhatsApp broadcast 3 |
| Wed 23 Dec | 19:00 | Instagram carousel: "5 recurring payments people forget" (illustrative) |
| Thu 24 Dec | 20:00 | Email 3 of onboarding sequence goes live for new cohort (auto) |
| Fri 25 Dec | 11:00 | Light day: community engagement only |
| Sat 26 Dec | 11:00 | CA partner check-in |
| Sun 27 Dec | 18:00 | Month-1 review: activation, aha, W1/W2, found-Rs, referral; decide Phase B budget |

## 6. Referral mechanic (no cash, nothing that looks like lending or payments)

Design principles: no cash, wallet credit, UPI payouts, vouchers, gift cards or discounts on financial products. No rewards tied to anyone borrowing, investing or paying anything. Rewards are product benefits only.

- **Mechanic: "Gift a month of Plus."** After a user's first aha, show an invite link. When the invited person activates (imports a first statement), both get one extra month of Plus features after the free public beta ends, or, while beta is free, a "founding member" badge and early access to new modules. Cap at 6 months per user.
- Counts only when the invitee activates, not on signup.
- Share through the OS share sheet only. No contact-list upload, no auto-messaging, no SMS reading.
- Invite text is pre-written, compliant, and editable by the sender (see WhatsApp messages in `CONTENT_PACK.md`).
- Anti-abuse: one reward per device and per phone / email; no self-referral; admin review of outliers.
- Legal checks before launch (to verify with counsel): store rules on in-app rewards, Razorpay billing terms for free-month credits, DPDP Act 2023 consent for sharing referral relationships, and that the reward is not a prohibited inducement under any applicable rule.
- Public copy for the mechanic: "Invite a friend. When they import their first statement, you both get a month of Plus." No Rs value mentioned.

## 7. Budget tiers (per month)

| Tier | Spend | What it buys | Expected use |
| --- | --- | --- | --- |
| Rs 0 | Rs 0 | Founder time only: WhatsApp, LinkedIn, Reddit, CA meetings, society talks, alumni groups; free design via Canva free tier (to verify terms); recorded reels on a phone | Phase A. Expect slow but highest-trust growth |
| Rs 25,000 | Rs 25k | Rs 8k society talk logistics (refreshments, printed QR cards), Rs 7k reel editing freelancer, Rs 5k micro-creator pilots (2 to 3 posts, with ASCI-style disclosure), Rs 5k tools (email, analytics, link shortener) | Phase A to B. Test which content converts |
| Rs 1,00,000 | Rs 1L | Rs 35k paid social tests (Meta, Google App) into landing page, Rs 20k creators, Rs 15k society and coworking sessions, Rs 15k video production, Rs 10k tools, Rs 5k legal/ASCI review of ads or press | Phase B to C. Only after organic activation >= 40% of signups |

Kill rule: any paid channel whose cost per activated user exceeds the working ceiling set at the start of the month (propose Rs 150 per activated user for Plus-eligible markets pending real data; hypothesis, not sourced) is paused after 2 weeks.

## 8. Metrics dashboard (weekly)

| Metric | Definition | Cadence |
| --- | --- | --- |
| Signups by channel | Count with UTM | Daily |
| Activation rate | Users with >= 1 statement imported / signups | Weekly |
| Time to activation | Median minutes signup to first import | Weekly |
| Aha rate | Activated users with >= 1 move showing Rs found / activated | Weekly |
| Found Rs per user | Median monthly Rs found across aha users | Monthly, aggregated only |
| Saved (proved) | Rs proven by receipts, aggregated, n >= 20 | Monthly |
| Retention | W1 / W4 / M2 opens among activated | Weekly |
| Referral K | Invites sent per aha user x invite-to-activation rate | Weekly |
| Support load | Tickets per 100 users, top 3 themes | Weekly |
| Trust signals | Complaints about privacy, "scam" mentions, store ratings | Weekly |

Privacy rules: events carry no statement text and no amounts per user; engine runs on device; only opt-in anonymous savings reports leave the device (per SAVINGS_SPEC).

## 9. What could kill this (and counter-moves)

| # | Threat | Why it is real | Counter-move |
| --- | --- | --- | --- |
| 1 | **Trust: "an app reading my bank statement"** | Indian users are wary after loan-app scams and fraud; statements are very sensitive | Say "on your phone" with proof (privacy page, open explanation of what leaves the device = nothing), no lending, no SMS reading, delete-everything button, publish a plain security note (see `SECURITY.md`), get a third-party security review before big spend |
| 2 | **Aha takes too long**: users sign up but never import a statement | Getting a PDF from the bank is friction | Step-by-step "get your statement" guide per bank, CSV and pasted text support, 15-minute assisted sessions, measure activation drop-off by step |
| 3 | **Moves show little Rs** (aha is weak) | Real users may have few savable items; unknown prices produce no claim (spec) | Be honest: show "nothing found" gracefully; add more modules based on the research queue; consider Rs found as a minor KPI and "clarity" as the main value |
| 4 | **Wrong or stale price data** | Offer pages change; conflicting data like Jio Gemini case | "Reported price, check before switching" label; monitoring + admin verification within 30 days; rapid retraction path; never advertise a specific number |
| 5 | **Compliance / misleading claims** | CCPA and the Consumer Protection Act 2019 treat false guarantees as misleading ads (research page); RBI Digital Lending Directions if you route to lenders | Brand review of all copy against this plan's rules; no guarantee, no lender routing; legal sign-off before any "switch" CTA |
| 6 | **CRED / INDmoney / banks copy the feature** | They have distribution | Compete on neutrality (no lender revenue) and depth in Indian recurring categories; move fast on city packs; do not claim they cannot copy |
| 7 | **Google Play / Apple policy** | Financial apps face scrutiny; SMS and permission rules | No SMS reading, accurate data-safety forms, no lending, clear privacy policy |
| 8 | **Users will not pay** | Many Indian consumers expect finance apps to be free; benchmark prices (see PRICING_RESEARCH) | Test Plus value via the beta survey; keep Free tier genuinely useful; consider a Business tier for a higher-value segment; do not charge until proof of value |
| 9 | **WhatsApp / community bans** | Spammy-looking promotion gets admins to ban | Ask admins; give value first (a session, a checklist); never bulk-add; use broadcast only with opt-in |
| 10 | **Single-founder burnout** | Founder is the channel in Phase A | Cap personal outreach at 20 a day; batch content; recruit 2 student interns on a volunteer-compliant basis (to verify legal terms) |
| 11 | **Data breach or incident** | Even on-device-first, sync data exists | Follow `INCIDENT_RESPONSE.md`; pre-written user notice; practise a drill before 1,000 users |
| 12 | **Fi-style wind-down: no sharp, paid job** | The research page notes Fi wound down in 2026 | Pick a sharp job ("find and watch recurring bills"), measure willingness to pay early, keep burn low |
| 13 | **Referral gaming** | Free-month credit invites fake accounts | Reward only on activation; one per device; cap |
| 14 | **Bad press from one wrong claim** | Screenshots travel | A 2-person check on every post; "Illustrative" labels; fast correction policy |

## 10. Decision gates

- End of Week 4: Go to Phase B only if >= 100 activated users and activation rate >= 30% (hypothesis).
- Month 4: Start the Plus paid-flow pilot only if W4 retention >= 25% and the pricing survey supports it (see `PRICING_RESEARCH.md`).
- Before any paid media: lawyer review of ad copy, store listing, and press note.
