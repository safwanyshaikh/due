=== 9929d3fe-Claude_Code_prompt_implement_Due_s_competitive_redesign.docx
Claude Code prompt: implement Due’s competitive redesign

You are implementing a production-ready redesign of the existing Due app at <u>https://due.karigarai.com/</u>. Do not create a static mockup, screenshot, or throwaway prototype. First inspect the existing repository, routes, data model, persistence, build scripts, and deployed behavior. Preserve working functionality unless the requirements below replace it. Make the changes in the real app, run the project’s tests/build, and leave a coherent, maintainable implementation.

Product goal

Due is a calm obligation/reminder product, not an all-in-one bank dashboard. The home screen must answer: **what is due next, when, how much, how certain is that information, and what should I do?** Use manual-first value, optional imports, explainable automation, and reversible actions.

Required home-screen implementation

At 390×844, implement this exact first-viewport hierarchy:

1.  56px top bar: Due wordmark left; profile/settings right.

2.  56px reassurance header: “Next 7 days” and a calm, data-dependent summary. Include “Why?”.

3.  176px minimum hero obligation card, 24px radius, 20px padding. Show service, amount/currency, exact date, date-confidence badge, source/payment-rail badge, status, and primary Review action. Add Snooze and Edit as visible secondary actions.

4.  72px cash strip: Next 7 days total, Next 30 days total, Needs attention count.

5.  180–220px next-3 timeline ordered by date, not category. Each row is at least 64px tall and includes service, date, amount, confidence, and inline action.

6.  64px bottom action row with Add due item and Import.

Use 24px mobile horizontal padding, 32px desktop padding, an 8dp spacing token system, 16px section gaps, 8px label/control gaps, 32px major-section gaps, and a 960px desktop max width. Every interactive target must be at least 48×48px, with keyboard focus, screen-reader labels, and visible pressed/selected/success/undo states. Keep charts, budgets, and category tiles below the obligation timeline. Category tiles may remain on a dedicated All page, but must not compete with the first obligation.

Data and correctness

Extend or preserve the data model to support: one-time, monthly, quarterly, half-yearly, annual, end-of-month, weekday, custom-month, trial-to-paid, and irregular/unknown schedules. Test February and 28/30/31-day transitions. Store date/amount confidence and provenance separately from the value. Allow a user to edit the next occurrence without silently rewriting historical events. Show plain-language recurrence rules and an audit entry for corrections.

Every obligation row/card must expose: merchant nickname, canonical provider, amount/currency, next date, recurrence rule, confirmed/estimated/user-entered/imported confidence, source badge, owner, reminder state, and a reversible action. Add explainability UI: “Why this?” opens a sheet with match logic, source, last sync/import time, and confidence.

Implement duplicate detection and merchant-alias merging as reviewable suggestions, not silent mutations. The import review queue must support Approve, Edit, Ignore, and Undo while preserving raw-source provenance.

Tactile interaction

Implement restrained jelly feedback: press scale 0.985 for 90ms, spring back to 1.0 over about 180ms, and a 2px-to-8px accent-ring success animation over 220ms. Respect <u>prefers-reduced-motion</u> by removing scale/spring and retaining color/state feedback. Rows may support touch swipes, but swipes are never the only path: right reveals Mark reviewed/paid; left reveals Snooze and Edit. Destructive actions require confirmation. All mutations show an Undo action for at least 6 seconds and create an audit-log event.

Auth and onboarding

Make the primary landing CTA “See my next due date”. Offer “Continue with email” and “Use without an account”. Guest/manual mode must let a user create and see one obligation before authentication. Require auth only for backup, synced reminders, household sharing, or multi-device access. Implement passkey or passwordless email if the existing stack supports it; otherwise implement secure magic-link email with session/device management and a clear sign-out/revoke path.

Add an email-ingestion explanation next to the CTA/permission step using this exact copy:

Import receipts, not your inbox. Due reads only messages you explicitly forward or connect, extracts merchant/amount/date/link, and shows every field for approval before saving. It does not read unrelated mail, bank passwords, card numbers, UPI PINs, or full inbox history. You can delete imported data and disconnect the source anytime.

Use explicit permission preview, sample receipt, extraction confidence, source badge, and Review/Ignore controls. Do not describe the existing billing-email label as automatic inbox reading; if it remains, label it clearly as organization-only.

Privacy, connection health, and deletion

If financial connections exist, show account scope, read-only capability, last sync, retry, alternate import/manual fallback, and disconnect/delete/export controls. Never imply that a connection can cancel or move money unless the implementation truly can. Keep privacy language adjacent to the action, not only in settings.

Monetization

Implement entitlement-aware Free and Premium tiers. Free includes manual obligations, next-7/30-day view, basic reminders, CSV export, and local data. Premium gates email/receipt extraction, bank/statement imports, calendar sync, household sharing, advanced recurrence rules, reconciliation history, multi-channel delivery, cancellation guidance, and verified action evidence.

Use configurable product constants for prices; initial hypotheses are Plus ₹149/month or ₹1,299/year and Household ₹249/month or ₹2,199/year. Do not hard-code prices in UI components. Before checkout show exact price, billing cadence, renewal date, purchase channel, cancellation path, and refund terms. Implement restore purchase and server-side entitlement checks if a backend exists. Do not create surprise annual renewals.

Retention and reminders

Implement event-based retention: weekly digest, trial-expiry reminder, date/amount change, stale-source warning, and monthly “covered / saved / avoided surprises” summary. Add per-obligation lead time, quiet hours, timezone, severity, snooze, acknowledge, channel preference, and delivery status. Do not send notifications merely to increase opens. Make all reminders editable and reversible.

Visual direction

Use a calm, restrained palette and generous hierarchy. The first viewport should feel reassuring, not gamified or alarmist. Use tabular numerals for money, strong contrast, accessible light/dark themes, 8dp spacing tokens, large hit targets, and no unnecessary gradients or decorative motion. Neutral copy examples: “You’re covered for this bill”, “Date estimated”, “Want to adjust?”. Reserve urgent color for actual risk.

Engineering requirements

- Inspect and reuse the existing stack and components before adding dependencies.

- Keep domain logic (recurrence, confidence, reminders, entitlements) separate from presentation.

- Add unit tests for all recurrence rules, end-of-month behavior, trial-to-paid, duplicate review, undo/audit, permission boundaries, and reminder quiet hours/timezones.

- Add responsive tests or snapshots at 320, 390, 768, and 1440px.

- Add accessibility checks for keyboard navigation, focus order, labels, contrast, reduced motion, and screen-reader action names.

- Do not use fake network responses or placeholder buttons for production paths. If a provider is unavailable, show a truthful disabled/unavailable state with a manual alternative.

- Preserve existing local data through a versioned migration. Provide export and delete paths.

- Run lint, typecheck, unit tests, build, and any existing end-to-end tests. Fix failures rather than suppressing them.

Definition of done

A reviewer can open the real app, create an obligation without signing in, understand its date/amount confidence, edit the next date, approve or ignore an imported receipt, snooze and undo a reminder, inspect “Why this?”, authenticate for sync, and see a transparent premium screen. At 390×844 the first viewport matches the specified order and measurements. No category tile appears above the next obligation. The implementation is production code with tests, not a visual mockup. Report changed files, migrations, test commands/results, and any provider limitations at the end.

Reference benchmark and citations: <u>/home/ubuntu/due_competitive_ux_and_traction_benchmark.md</u>.
=== ae9a3bdf-Due_competitive_UX_and_traction_benchmark.docx
Due competitive UX and traction benchmark

Executive decision

Due should not become another all-in-one finance dashboard. The defensible wedge is a calm obligation system: **what is due next, how much cash it requires, how certain the date/amount is, and what safe action is available**. This is narrower than Rocket Money, Copilot, PocketGuard, YNAB, and Monarch, while retaining their strongest patterns: progressive account connection, review/approve controls, explainable alerts, privacy-funded pricing, and household utility \[2–10\].

What is wrong with the current prototype

The deployed prototype is technically thoughtful but its first screen is organized as a category hub rather than a decision surface \[1\]. Its visual system gives equal prominence to large pastel tiles for Subscriptions, EMIs, bills, credit-card bills, school fees, and other commitments; that forces the user to choose a taxonomy before seeing the next obligation. The CSS confirms a broad 880px shell, a 3-column tile grid that collapses to two/one columns, 168px minimum tile height, 20px page padding, and 24px rounded cards \[1\]. That produces a pleasant catalog, but not the requested “what must happen next?” answer.

Specific problems to replace:

1.  **No dominant near-term answer.** The first viewport should lead with the nearest due item, total due in the next 7/30 days, and one action. The prototype’s category tiles compete with those facts.

2.  **Taxonomy before intent.** A user who only wants to know whether ₹X is due this week must scan categories. Group by urgency/date first; let type become a filter.

3.  **Weak evidence hierarchy.** Dates and amounts need visible provenance and confidence (confirmed, imported, estimated, user-entered). Competitor reviews specifically expose recurring-date errors and irregular-payday gaps \[2\].

4.  **Reminder semantics are under-explained.** “Reminder” must expose lead time, channel, quiet hours, snooze, and whether email is actually read. Due’s own current copy says billing-email labels organize records and do not read inboxes; that distinction must move next to the CTA, not remain buried in form help \[1\].

5.  **Action completion is not the primary loop.** A tile can open an editor, but the home surface should support Review, Snooze, Mark paid, Edit date, and Undo without destructive ambiguity. Copilot’s explicit Dismiss/Approve model is the benchmark \[3\].

6.  **The prototype risks broad-finance sprawl.** Budget/analytics/settings can exist, but they should be progressive disclosure below the obligation timeline. Rocket Money and Copilot prove breadth can drive acquisition, but also create explainability, navigation, and notification-load risks \[2,3\].

Exact replacement first viewport

Target mobile width 390px and desktop max width 960px. Use an 8dp spacing token system, 24dp mobile horizontal padding, 32dp desktop padding, 16dp between sections, 8dp label/control gaps, and 32dp between major sections. All interactive targets are at least 48x48dp with 8dp separation, consistent with Material guidance \[9\].

At 390px viewport height 844px, the first viewport should contain:

- **Top bar: 56px high.** Due wordmark left; profile/settings icon right. No category navigation. Use 24px side padding.

- **Reassurance header: 56px.** Eyebrow “Next 7 days”; title “You’re covered for ₹X” only when the data supports it; otherwise “Your next commitment is clear.” Include a compact “Why?” link.

- **Hero obligation card: 176px minimum, 24px radius, 20px internal padding.** Show merchant/service, amount, exact date, date confidence badge, payment rail/source badge, and one primary action (“Review”). Secondary actions are icon/text buttons: Snooze, Edit. Never hide uncertainty.

- **Cash strip: 72px.** Three values, not three competing cards: “Next 7 days ₹X”, “Next 30 days ₹Y”, “Needs attention N”. Use 12px gaps and tabular numerals.

- **Timeline section: 180–220px visible.** Show the next 3 obligations ordered by date, not category. Each row is 64px minimum and includes merchant, date, amount, confidence, and one inline action.

- **Bottom action row: 64px.** Primary “Add due item”; secondary “Import”. Place “Connect account” below the fold or as a contextual enhancement after manual value is visible.

Desktop may add a 280px right rail for filters and a monthly total, but the left 640px column keeps the same hierarchy. Never put a chart, net-worth number, or category tile above the next obligation.

Tile/order and content rules

Replace the current category-tile-first home with this order:

7.  **Next due / next renewal**: service, amount, date, confidence, source, status, Review.

8.  **Needs attention**: changed amount/date, stale connection, unknown merchant, trial ending, overdue user-entered item.

9.  **Next 7 days timeline**.

10. **Next 30 days total and cash-flow calendar**.

11. **All obligations**, filterable by type, owner, rail, essential/optional, and confidence.

12. **Category tiles only on the dedicated “All” page**, where each tile is compact (minimum 112px high) and secondary to the date timeline.

Every obligation tile/row must show: merchant nickname, canonical merchant/provider, amount and currency, recurrence rule, next date, “confirmed/estimated/user-entered/imported” confidence, source badge, owner, reminder state, and a reversible action. For annual, end-of-month, weekday, custom, trial-to-paid, and irregular-income cases, show the rule in plain language and permit manual next-date overrides \[2,3,5\].

Jelly/tactile interaction behavior

Use restrained “jelly” feedback, not decorative motion: on press, scale to 0.985 for 90ms; on release, spring to 1.0 with 180ms ease-out; on successful state change, a 2px accent ring expands to 8px opacity 0 over 220ms. Respect <u>prefers-reduced-motion</u> by removing scale/spring and retaining color/state feedback.

Rows are full-row hit targets. Swipe is optional on touch and must never be the only path: right swipe reveals “Mark reviewed/paid”; left swipe reveals “Snooze” and “Edit”. Require confirmation for cancellation-like or data-deletion actions. Every mutation shows an inline toast with **Undo** for at least 6 seconds and writes an audit event. “Why this?” opens a bottom sheet explaining match logic, source, last sync, and confidence. Tactility must communicate state, not disguise uncertainty.

Auth CTA and email-ingestion explanation

Use a value-first CTA: **“See my next due date”** on the landing state, followed by **“Continue with email”** and **“Use without an account”**. Guest/manual mode must create a useful first obligation before authentication. Auth is required only for backup, reminders sync, household sharing, or multi-device access; offer passkey/Apple/Google plus email magic link, and explain session/device control.

The email-ingestion card must say exactly: **“Import receipts, not your inbox. Due reads only messages you explicitly forward or connect, extracts merchant/amount/date/link, and shows every field for approval before saving. It does not read unrelated mail, bank passwords, card numbers, UPI PINs, or full inbox history. You can delete imported data and disconnect the source anytime.”** Use an explicit permission preview, a sample receipt, source badge, extraction confidence, and Review/Ignore controls. The current prototype’s “billing-email label” is organization only—not inbox reading—and must not be presented as automatic email ingestion \[1\].

Premium monetization and retention

Keep the core free: manual obligations, next-7/30-day view, basic reminders, CSV export, and local data. Premium should charge for costly, outcome-producing capabilities: email/receipt extraction, bank/statement imports, calendar sync, household sharing, advanced recurrence rules, confidence/reconciliation history, multi-channel delivery, cancellation guidance, and verified action evidence. Use plain pricing: e.g., Free; Plus ₹149/month or ₹1,299/year; Household ₹249/month or ₹2,199/year. Validate price experimentally; these are product hypotheses, not competitor facts.

Show price, renewal date, channel, cancellation path, and refund terms before payment. Do not use a surprise annual renewal. Competitor evidence supports free cores or trials, but also shows that unclear trial/annual billing creates distrust \[2,3,5,6,7\]. Retention should be an event loop: weekly digest, trial-expiry reminder, amount/date change, stale-source warning, and monthly “covered / saved / avoided surprises” summary. Add quiet hours, severity levels, snooze, acknowledge, and channel controls. Measure activation as the first obligation understood and handled; measure retention as fewer missed/late surprises and repeat weekly resolution—not daily opens \[2–10\].

Build acceptance checklist

- At 390×844, the first viewport shows next-7-day state, hero obligation, 7/30-day totals, three dated rows, and Add/Import actions in the specified order.

- No category tile or chart appears above the first obligation.

- Mobile padding is 24dp; desktop content max is 960px; 8dp tokens are used; major section gap is 32dp.

- Every interactive target is ≥48×48dp and keyboard/focus/screen-reader accessible.

- Every date, amount, recurrence, and source has visible confidence/provenance; users can override the next date without rewriting history.

- Supports end-of-month, weekday, annual, custom-month, trial-to-paid, one-time, and irregular-income scenarios with tests for February and 28/30/31-day transitions.

- Import queue deduplicates merchant aliases, explains matches, supports Ignore/Edit/Approve, and preserves raw-source provenance.

- Email copy accurately distinguishes explicit forwarding/connection from inbox reading; no unsupported privacy claims.

- Swipe actions have visible button alternatives, confirmation where destructive, 6-second Undo, and audit-log entries.

- Reduced-motion mode removes jelly animation while preserving state feedback.

- Auth can be deferred until backup/sync/reminders; passkey or passwordless email is implemented with device/session management.

- Free and premium entitlements are enforced server-side, with transparent price/renewal/cancel/refund screens and restore-purchase support.

- Reminder engine supports quiet hours, timezone, lead-time per item, snooze, acknowledge, channel preference, and delivery status.

- Connection health shows last sync, retry, alternate import, account scope, read-only capability, and delete/export controls.

- Automated tests cover recurrence correctness, duplicate detection, permission boundaries, undo/audit behavior, responsive layout, and accessibility.

- Production telemetry measures first obligation completed, import approval rate, reminder resolution, correction rate, missed/late surprises, trial conversion, churn reason, and notification opt-outs.

Numbered references

\[1\] Due prototype, deployed site and observable UI/CSS/JS: <https://due.karigarai.com/>

\[2\] Rocket Money product, pricing, security, FAQ, and App Store evidence: <https://www.rocketmoney.com/> ; <https://www.rocketmoney.com/feature/manage-subscriptions> ; <https://www.rocketmoney.com/learn/personal-finance/how-much-does-rocket-money-cost> ; <https://www.rocketmoney.com/security> ; <https://apps.apple.com/us/app/rocket-money-bills-budgets/id1130616675>

\[3\] Copilot Money product, quick start, connections, subscription, and App Store evidence: <https://www.copilot.money/> ; <https://help.copilot.money/en/articles/11157550-quick-start-guide> ; <https://help.copilot.money/en/articles/5593601-adding-and-managing-connected-accounts> ; <https://help.copilot.money/en/articles/6860727-managing-your-copilot-subscription> ; <https://apps.apple.com/us/app/copilot-track-budget-money/id1447330651>

\[4\] Bobby subscription tracker and App Store evidence: <https://bobbyapp.co/> ; <https://apps.apple.com/us/app/bobby-track-subscriptions/id1059152023>

\[5\] PocketGuard product, pricing, recurring bills, security, and App Store/Play evidence: <https://pocketguard.com/> ; <https://pocketguard.com/pricing/> ; <https://pocketguard.com/recurring/> ; <https://pocketguard.com/help/bills/> ; <https://pocketguard.com/help-category/security/> ; <https://apps.apple.com/us/app/pocketguard-budget-app/id949414211> ; <https://play.google.com/store/apps/details?id=com.pocketguard.android.app&hl=en_US>

\[6\] Indian benchmarks (Nance, KeepMyPlans, FinArt): <https://nanceapp.com/> ; <https://www.keepmyplans.com/> ; <https://finart.app/> ; <https://play.google.com/store/apps/details?id=com.finart&hl=en_US> ; <https://apps.apple.com/us/app/finart-track-expenses-bills/id6748001842>

\[7\] YNAB and Monarch pricing/trust positioning: <https://www.ynab.com/pricing> ; <https://www.monarchmoney.com/pricing>

\[8\] Material Design spacing: <https://m3.material.io/styles/spacing>

\[9\] Material Design structure and touch-target guidance: <https://m3.material.io/foundations/designing/structure>

\[10\] PocketGuard account-linking/manual mode evidence: <https://pocketguard.com/help/can-i-use-pocketguard-without-linking-an-account-and-why-linking-accounts-is-important/>
