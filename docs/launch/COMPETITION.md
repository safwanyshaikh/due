# Competition

Source for every score and description below: `docs/research/value-graph-v2.html` (section "Brutal competitor audit", 23 Nov 2026). Scores (0 to 5) are Due's own judgment from public information, not measurements. "Due (target)" is the bar the product must reach, not what is built today. Items marked "not verified" were not checked in the source.

Axes (from the source): **Covers** = how much of a household's recurring spend it sees. **Life** = commute, food and telecom awareness. **Proof** = shows savings actually achieved. **Neutral** = no lender or merchant money steering advice. **India** = works for India today. **Model** = how it earns, in words.

| App | What it is | Covers | Life | Proof | Neutral | India | Model |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CRED | Card bill pay and rewards; members-only; sells loans via lenders | 2 | 1 | 1 | 1 | 5 | Lender and merchant revenue |
| Paisabazaar | Loan and card marketplace, free score | 1 | 0 | 0 | 1 | 5 | Lead sales to lenders |
| BankBazaar | Loan and card comparison and score | 1 | 0 | 0 | 1 | 5 | Lead sales to lenders |
| INDmoney | Investments, net worth and tracking | 3 | 0 | 1 | 2 | 5 | Investment products |
| Moneyview | Loans and money manager (premium reported) | 2 | 0 | 0 | 1 | 4 | Loans plus premium |
| Walnut | SMS-reading expense tracker | 3 | 1 | 0 | 4 | 3 | Not verified |
| Rocket Money (US) | Subscriptions and bill negotiation, fee only on success | 4 | 1 | 3 | 3 | 0 | Success fee plus premium |
| Monarch (US) | Paid budgeting, no ads, no free tier | 4 | 0 | 2 | 5 | 0 | Subscription only |
| Cleo / Emma (US / UK) | Chat-style money coach / UK subscriptions | 3 | 0 | 1 | 3 | 0 | Not verified |
| **Due (target)** | Every recurring rupee, life patterns and proof; earns only from users | 5 | 5 | 5 | 5 | 5 | Free tier plus Plus (hypothesis) |

Reading it: lender-funded apps score low on neutrality; Western apps do not work in India; SMS-reading trackers see a lot but are a privacy and Play-policy risk. Due's position is neutral, India-first, information-only, and proof-based. Public copy makes no guarantee or minimum-saving claim.

Lessons noted in the source: CRED can copy features but not neutrality while it earns from loans; Fi wound down in 2026 (no moat without a sharp, paid job); Rocket Money's success-fee negotiation is an idea to learn from, though Due only shows how and never acts.

The public comparison page (`/compare`, linked from the landing page) uses this table: five columns (Due, CRED, INDmoney, Rocket Money, Monarch Money), plain names only, "Not stated" wherever the research does not say, dated "as of Nov 2026". Content lives in `src/content/compare.ts`; update it after every monthly check below.

## Watch list: monthly process

Owner: **Founder**. When: first Monday of each month, 30 minutes. Compare each page with the previous log entry; look for new features, pricing changes, shut-downs and new marketing claims. Add one line per competitor per month to the log below, even if "no change". Anything that changes a score above: update the table and mention the source URL and date. Do not copy competitor text; summarise.

| Competitor | Pages to check (confirm URLs still resolve; update if moved) |
| --- | --- |
| CRED | https://cred.club/ and https://cred.club/articles |
| Paisabazaar | https://www.paisabazaar.com/ |
| BankBazaar | https://www.bankbazaar.com/ |
| INDmoney | https://www.indmoney.com/ |
| Moneyview | https://moneyview.in/ |
| Walnut | https://www.getwalnut.com/ (and its store listings) |
| Rocket Money | https://www.rocketmoney.com/ and https://help.rocketmoney.com/ (pricing, negotiation fee) |
| Monarch | https://www.monarch.com/pricing |
| Cleo | https://web.meetcleo.com/ |
| Emma | https://emma-app.com/ |

Also check each app's Play Store and App Store page for "what's new" and rating changes.

### Log

| Date | Checked by | Competitor | What changed | Action (score update, idea, none) |
| --- | --- | --- | --- | --- |
| 2026-11-25 | Claude | all | Initial table created from value-graph-v2.html; no live pages checked | First Founder check due Mon 2026-12-07 |
