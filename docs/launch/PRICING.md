# Pricing and tiers

**Status: free public beta.** While `beta.plus_free` is on (Admin > Settings > Free public beta) every signed-in account gets Plus features and nothing is charged. Checkout returns a clear 409 `beta_free`. Turn the setting off to start the paid flow through the existing Razorpay integration, with no rebuild.

Prices are set by an admin (Admin > Plans) and are **hypotheses to test, not final prices**. The values below are the current hypotheses in `src/lib/plans.ts`; the live database values override them.

| | Free | Plus | Business (planned) |
| --- | --- | --- | --- |
| Status | Live | Live (free during beta) | Not built, not sold |
| Price (hypothesis) | Free | Rs 149 per month or Rs 1,299 per year (hypothesis) | To be decided after beta feedback |
| Who it is for | Anyone tracking their own bills | People who want Due to find and watch things for them | Small teams or sole proprietors paying many vendors |
| Value | Add items yourself; next 7 and 30 days; basic in-app reminders; CSV export; data stays on your device | Everything in Free, plus: Gmail scanning (read-only), email forwarding, unlimited document uploads (Free: 5 a month), email reminders, offer matches for your plans, sync and backup across devices, advanced schedules, cancellation guidance, proof of actions | Everything in Plus, plus (ideas to validate): shared access for several people, team reminders, export for accountants |

Notes
- A Household plan (Rs 249 per month or Rs 2,199 per year hypothesis) exists in code but is switched off until sharing is ready. It is a candidate shape for Business or a family tier; decide after beta.
- The yearly price is only used if the user explicitly chooses it; there are no surprise annual renewals.
- No claim of guaranteed or minimum savings is made in any tier. Due shows information; the user decides.
- Before charging: fill billing terms and legal review (Admin > Settings > billing terms), set prices in Admin > Plans, create the plans in Razorpay, add the plan ids and keys, and review `docs/production/RUNBOOK.md`.
