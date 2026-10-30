FINAL CLAUDE CODE BUILD PROMPT — DUE COMMERCIAL LAUNCH

You are the lead product engineer, security engineer, product designer, and release manager for Due, an India-first recurring-payables and offer-intelligence platform.

Do not create another mockup, static HTML demo, or disconnected prototype. Inspect the existing Due repository and live deployment, preserve useful working code, and implement the missing production functionality end to end.

The task is complete only when the real application is built, tested, deployed, health-checked, and pushed to the production branch. Never claim a feature is live unless it has been tested against the deployed backend.

Product positioning

Due is not a bank, wallet, lender, payment app, coupon marketplace, or CRM.

Due helps people understand:

-   what subscriptions, EMIs, loans, cards, school fees, bills, and other commitments are coming;

-   how much is planned for the next 7, 30, and 365 days;

-   which benefits, OTT services, cloud storage, AI trials, roaming benefits, cashback, and bundles their existing plans may already include;

-   what is expiring, renewing, duplicated, uncertain, or worth reviewing;

-   what the user should verify before spending money.

Core promise:

Know what’s coming. Save what you can. Stay in control.

Due must never pay, recharge, activate, redeem, cancel, pause, migrate, port, create mandates, capture OTPs, perform KYC, or accept partner terms. Final provider actions are always a user-controlled handoff to the official provider app or website.

Current problems to fix

The current application has an attractive prototype layer but is not yet a complete commercial product. Replace or complete these gaps:

-   browser-only data with secure optional household accounts and sync;

-   email-only sign-in with complete account recovery, session security, and device management;

-   non-live forwarding with real inbound email through Postmark or Mailgun;

-   no Gmail discovery with optional read-only Gmail OAuth;

-   no multi-email identity management;

-   document upload without production OCR/security pipeline;

-   static offer catalog without a continuously refreshed intelligence engine;

-   incomplete billing configuration with production Razorpay integration;

-   generic empty screens with a compact, premium, tile-first experience;

-   excessive hero whitespace and weak first-screen value;

-   category tiles hidden behind secondary navigation;

-   no tactile tile interaction;

-   incomplete privacy, consent, retention, grievance, and deletion controls.

Design direction

The first viewport must feel like a calm premium mobile product, not a generated dashboard.

At 390×844, show immediately:

1.  compact header with Due logo, account, privacy/settings;

2.  small greeting and date context;

3.  one summary card: planned this month, next due item, confidence/source;

4.  the primary tiles beginning within the first viewport;

5.  no oversized hero gap, no empty marketing panel, no long explanation before utility.

Use an 8px spacing system:

-   mobile page padding: 16–20px;

-   desktop page padding: 24–32px;

-   major section gap: 24px;

-   card gap: 12–16px;

-   label/control gap: 8px;

-   minimum interactive target: 48px.

The tile order is:

6.  Subscriptions

7.  EMIs

8.  Credit cards

9.  Other loans

10. Bills and essentials

11. School fees

12. Due & Offers

13. Seasonal plans

Every tile must show a simple value or helpful empty state. Do not hide the core categories on a separate page.

Jelly interaction

Implement a tasteful tactile interaction for tiles and primary buttons:

-   pointer/touch down: scale to 0.97–0.985;

-   subtle spring/elastic release within 180–260ms;

-   small icon translation or soft highlight;

-   visible pressed, focus, selected, success, and undo states;

-   no excessive bounce or childish animation;

-   respect prefers-reduced-motion and the in-app Reduce Motion setting;

-   keyboard and screen-reader behavior must remain correct.

No-auth value path

Do not force account creation before value. The first-use choices are:

-   Add manually

-   Upload a bill or sanction letter

-   Forward a subscription email

-   Connect Gmail

-   Sign in for sync and reminders

Guest users can manually add, upload, review, and export. Login becomes valuable for backup, cross-device sync, reminders, forwarding history, Gmail connection, household sharing, and recovery.

Household authentication

Implement production household accounts separately from admin accounts.

Required:

-   passwordless email magic link or secure password flow;

-   one-time link expiry and single-use enforcement;

-   session rotation and secure httpOnly cookies;

-   device/session list and revoke action;

-   rate limiting and abuse protection;

-   password reset if passwords are supported;

-   account export;

-   account deletion and data deletion confirmation;

-   consent records;

-   audit log for sensitive account actions;

-   no tokens in logs;

-   no raw financial content in analytics.

Guest intake must be isolated and expire unless the user signs in or exports it.

Gmail OAuth connector

Implement optional Google OAuth for users who choose Connect Gmail.

Use the least-privilege feasible Gmail API scope. Do not request full mailbox access when a narrower scope is sufficient. Clearly explain the permission before redirecting to Google.

Consent copy:

Due searches only for relevant billing, renewal, subscription, loan, card, recharge, invoice, and trial messages. Due cannot send, delete, reply, pay, cancel, or change anything in your Gmail.

Support search across:

-   CATEGORY_UPDATES;

-   CATEGORY_PROMOTIONS;

-   CATEGORY_PERSONAL;

-   sender/domain filters;

-   keywords: subscription, renewal, trial, invoice, bill, EMI, loan, statement, recharge, payment, due, auto-renew, mandate, card, school fee, insurance, utility.

Do not rely only on Gmail categories. Categories can be changed or disabled by users.

The scan must:

14. fetch only message metadata/body needed for extraction;

15. avoid attachments unless the user explicitly enables attachment processing;

16. deduplicate by Gmail message ID and normalized fingerprint;

17. classify receipt, renewal, trial, offer, recharge, card, EMI, loan, school fee, utility, or irrelevant;

18. extract provider, service, amount, currency, date, renewal, trial end, benefit, and source links;

19. show candidates in a review queue;

20. require confirmation before creating or changing a commitment;

21. save provider/source/message metadata, not unnecessary raw mail;

22. offer disconnect, revoke, delete imported data, and rescan controls;

23. never send, reply, delete, label, archive, cancel, pay, or modify Gmail messages.

Implement OAuth token encryption, refresh-token protection, consent timestamp, scope display, disconnect/revoke, retention policy, and Google verification documentation. If Google verification or production credentials are missing, show the exact blocker and keep the rest of the product deployable; never fake the connection.

Multi-email identities

A Due account may add multiple email identities:

-   Gmail account;

-   work email;

-   family/shared subscription email;

-   forwarding-only address.

Each identity must have its own consent, provider label, status, last scan, disconnect, and delete controls. Do not merge identities only by sender email. Link records using the authenticated Due account and explicit user confirmation.

Postmark/Mailgun inbound forwarding

Implement a real inbound email webhook using the configured provider.

Required configuration:

-   INBOUND_EMAIL_DOMAIN;

-   INBOUND_WEBHOOK_SECRET;

-   provider signing verification;

-   unique alias/token routing;

-   message ID deduplication;

-   normalized fingerprint deduplication;

-   malware and attachment policy;

-   raw-message short retention;

-   structured extraction;

-   review queue;

-   delete/export controls;

-   pause and rotate forwarding address.

Never use one shared public mailbox and infer the user only from sender email. A unique alias such as u84kd@inbox.due.app routes the message to the correct private workspace.

Document and bill intake

Support PDF, JPG, PNG, and common document uploads for:

-   bills;

-   sanction letters;

-   EMI schedules;

-   card statements;

-   school-fee notices;

-   recharge receipts;

-   subscription invoices;

-   renewal notices.

Use local parsing where practical. If server OCR is used, encrypt in transit, malware-scan, disclose the processor, set short raw retention, and permit immediate deletion.

Extract only needed planning fields:

-   provider;

-   commitment type;

-   amount/currency;

-   interest rate;

-   tenure;

-   EMI;

-   due date;

-   renewal date;

-   trial expiry;

-   included benefits;

-   reference label.

Show field-level confidence. Require user confirmation. Redact or reject Aadhaar, PAN, full card numbers, CVV, UPI PIN, bank passwords, signatures, and unnecessary identifiers. Do not use sanction letters for lending, underwriting, or credit scoring.

Offer Intelligence engine

Build a shared, append-only catalog that continuously researches and normalizes public provider information.

Initial provider families:

-   Jio;

-   Airtel;

-   Vi;

-   Amazon Prime and OTT;

-   Google One/Gemini;

-   Apple subscriptions;

-   banks/cards;

-   UPI/payment apps;

-   broadband and DTH;

-   insurance;

-   utilities;

-   education fees;

-   generic subscriptions.

Each offer record must include provider, product family, SKU, benefit type, price, billing period, benefit value, geography, source URLs, observed time, official start/end, last-confirmed time, page status, terms status, computed status, confidence, superseded record, and notes.

Benefit types:

-   recurring entitlement;

-   one-time reward;

-   free trial;

-   bundle;

-   capability.

Statuses:

-   active;

-   active—verify;

-   expired;

-   conflicting;

-   unknown.

A visible landing page does not prove an offer is active. Official terms override stale landing pages. Personalized app banners and checkout results remain provider-only until the user confirms them.

Implement:

-   source registry;

-   source cadence;

-   public fetch adapters;

-   parser/version history;

-   normalized fingerprints;

-   duplicate detection;

-   change detection;

-   source snapshots;

-   conflict detection;

-   historical records;

-   manual review queue;

-   last-checked display;

-   refresh logs;

-   health dashboard;

-   stale-source alerts.

The engine must analyze competitor changes and provider offers, but it must not scrape behind login, bypass robots/rate limits, reverse engineer private APIs, or copy protected content. Use official links and licensed/allowed sources.

Cross-calculation

When a user adds a plan, show possible included benefits and transparent estimates.

Examples:

-   Airtel recharge may include Prime for a limited period;

-   Jio/Airtel/Vi plans may include OTT access;

-   telecom plans may include cloud or AI benefits;

-   card/UPI offers may have minimum spends and one-time limits;

-   Google trials may convert to paid subscriptions;

-   an included subscription must not be double-counted inside a card statement.

Show assumptions, expiry, eligibility, confidence, and source. Never call uncertain value guaranteed savings.

Reminders

Support:

-   renewal reminder;

-   trial-ending reminder;

-   claim deadline;

-   offer expiry;

-   EMI/card/fee due date;

-   recheck date;

-   snooze;

-   quiet hours;

-   timezone;

-   in-app;

-   email;

-   calendar ICS;

-   WhatsApp only after compliant opt-in/template setup.

Do not send reminders until the user has chosen a channel and consented.

Pricing and monetization

Implement Razorpay subscription billing only after credentials and plans are configured.

Free tier should provide:

-   manual entries;

-   limited uploads;

-   basic reminders;

-   basic offer viewing;

-   export.

Plus tier can provide:

-   Gmail scanning;

-   inbound forwarding;

-   unlimited documents;

-   advanced reminders;

-   offer intelligence matches;

-   cross-device sync;

-   household features only when actually implemented;

-   priority support.

Pricing must be visible in INR, show renewal date, show tax where applicable, provide cancel/manage path, and never sell unavailable features. Do not enable Household billing until sharing works end to end.

Admin console

Admin must manage:

-   providers and source URLs;

-   parser versions;

-   offer observations;

-   active/expired/conflicting statuses;

-   refresh jobs;

-   review queue;

-   users and roles;

-   billing plans;

-   integration health;

-   audit log;

-   privacy/deletion requests;

-   incident status.

Admin roles: Viewer, Editor, Admin, Owner. Secure setup token must be one-time and removable. Never expose secrets in UI or logs.

Production environment variables

Document and validate:

-   database URL;

-   session/auth secrets;

-   SMTP_URL;

-   SMTP_FROM;

-   Google OAuth client ID/secret/redirect URL;

-   Gmail encryption key;

-   INBOUND_EMAIL_DOMAIN;

-   INBOUND_WEBHOOK_SECRET;

-   Postmark/Mailgun credentials;

-   DATA_ENCRYPTION_KEY;

-   Razorpay keys and webhook secret;

-   storage/OCR credentials if used;

-   application base URL;

-   admin setup token.

Fail safely with a clear health status when an integration is not configured. Do not display a fake connected state.

Quality gates

Before release, pass all of the following:

-   unit tests;

-   integration tests with real test database;

-   browser tests at 390×844, 768×1024, and desktop widths;

-   no sideways scroll from 320px to 1440px;

-   48px touch targets;

-   keyboard navigation;

-   screen-reader labels;

-   reduced-motion behavior;

-   auth link expiry and replay tests;

-   OAuth state/PKCE/redirect tests;

-   Gmail scope and disconnect tests;

-   forwarding signature and alias-routing tests;

-   duplicate email/message tests;

-   document redaction tests;

-   retention/deletion tests;

-   user-data isolation tests;

-   offer conflict/expiry tests;

-   reminder timezone/quiet-hour tests;

-   Razorpay webhook idempotency tests;

-   no payment/provider mutation endpoint tests;

-   security scan and dependency audit;

-   production build and migration test;

-   live smoke test after Render deployment.

Release definition

Do not stop at “tests pass.” Stop only after:

24. main contains the complete implementation;

25. migrations run on a clean and upgraded database;

26. Render deployment is live;

27. health endpoint is green;

28. household magic-link login works with configured SMTP;

29. guest mode works;

30. document review works;

31. Gmail OAuth works if Google credentials/verification are configured;

32. inbound forwarding works if Postmark/Mailgun is configured;

33. reminders work for at least one configured channel;

34. Razorpay test billing/webhook works if enabled;

35. offer catalog loads with source/status/freshness;

36. mobile first viewport is compact and polished;

37. all live and unavailable integrations are honestly labelled;

38. deployment URL, commit SHA, environment checklist, test results, and known limitations are reported.

If a third-party approval, credential, or DNS change is still required, do not call the product launched. Report the exact external action, verify every other completed feature, and keep the deployment safe and honest.

Final response format

Return:

-   production URL;

-   commit SHA;

-   deployment status;

-   features live;

-   features blocked by external setup;

-   exact environment variables still missing;

-   test counts and commands;

-   security/privacy checks;

-   known limitations;

-   rollback instructions.

No vague claims. No “ready” without live evidence.

PRODUCTION ARCHITECTURE ADDENDUM — MUST IMPLEMENT BEFORE LAUNCH

The following requirements are mandatory additions to the implementation above. Do not treat them as optional polish.

Runtime architecture

Separate the application into clear modules: web/API, authentication/session service, ingestion service, extraction/parser service, offer-catalog service, reminder/notification service, billing/webhook service, admin service, and background-worker service.

Long-running work must not run inside a synchronous web request. Gmail scans, inbound email parsing, OCR, offer refreshes, reminder delivery, webhook retries, and retention deletion must use a durable queue or scheduled worker with retry, backoff, dead-letter handling, idempotency keys, and visible job status.

Every asynchronous job must have: job ID, user/account scope, type, status, started/finished timestamps, retry count, error code, redacted error message, and correlation ID. Never put raw email, document content, OAuth tokens, payment data, or secrets into job logs.

Database and migrations

Use explicit relational tables or equivalent typed collections for users, sessions, devices, consents, email identities, Gmail connections, forwarded messages, uploaded documents, extracted candidates, commitments, reminders, offers, offer observations, parser versions, refresh jobs, notifications, billing customers, billing events, admin audit events, deletion requests, and webhook deliveries.

Add unique constraints for account identity, email provider message ID, forwarding alias, normalized fingerprints, external billing event ID, and job idempotency key. Use soft-delete only where required for audit, and enforce a documented purge schedule for raw email/document content.

Every migration must be forward-compatible, tested on a copy of the current production database, and accompanied by rollback or recovery instructions. Never run destructive schema changes without a backup and a migration lock.

Backup and disaster recovery

Configure automated encrypted database backups, retention windows, restore testing, and a documented recovery point objective and recovery time objective. Before production migrations, create and verify a backup. Test restoring a backup into a non-production database. Do not claim commercial readiness until restore has been proven.

Gmail OAuth and Google verification

Document the exact Google scopes. If body/content extraction is required, acknowledge that the required Gmail read scope may be sensitive or restricted and may require OAuth verification and a security assessment. Do not silently downgrade to a scope that cannot support the feature.

Implement OAuth state, PKCE where applicable, redirect URI allowlisting, token encryption with key rotation, refresh-token revocation, consent versioning, scope-change re-consent, disconnect/revoke, and deletion of imported Gmail data. Provide a Google OAuth test-mode path for development and a production verification checklist. The UI must distinguish OAuth configured, OAuth test mode, Google verification pending, and Gmail scanning live.

Email and document safety

For Postmark/Mailgun webhooks, verify provider signatures, reject replayed requests, enforce body/attachment size limits, scan attachments, restrict MIME types, normalize encodings safely, and isolate parser execution. Never render untrusted HTML directly. Sanitize links and never auto-open provider URLs.

Store raw messages/documents separately from extracted structured records with separate retention and access policies. Encrypt at rest. Restrict raw-content access to the minimum service role. Record every admin access to raw content in an audit log. Default retention must be short and user-configurable where legally/practically possible.

Consent and privacy state machine

Consent must be versioned and explicit for: household account creation, Gmail access, forwarded-email processing, document processing/OCR, reminders by each channel, analytics, offer personalization, and household sharing. Store consent timestamp, policy version, scope, source, and revocation timestamp.

When a user disconnects Gmail, stop future reads immediately, revoke tokens where possible, delete or anonymize imported message-derived data according to the disclosed policy, and preserve only the minimum audit record. When a user deletes an account, run an asynchronous deletion job and show progress plus any legally required retention exception.

Add privacy notice, terms, grievance/support contact, deletion policy, subprocessor list, and incident-contact configuration before commercial launch. Do not ship with “draft” privacy text or a placeholder grievance contact.

Security controls

Implement CSRF protection where cookie-authenticated state-changing requests exist, strict CORS allowlisting, secure headers including CSP, HSTS in production, input validation, output encoding, SSRF protection for source fetches, rate limits per IP/account/action, login-link abuse controls, brute-force protection, secret scanning in CI, dependency vulnerability scanning, and dependency lockfile review.

Use least-privilege service/database roles. Separate production, staging, and development credentials. Do not expose secrets to the client bundle. Rotate setup tokens and encryption keys according to a documented procedure. Ensure error pages never expose stack traces, SQL, tokens, provider payloads, or personal data.

Notifications and reminder reliability

Implement notification preferences per user and per channel. Every notification needs a delivery record, provider message ID, status, retry count, failure reason, and unsubscribe/disable path. Respect quiet hours, timezone, duplicate suppression, and user snooze. Email reminders must include a secure deep link that requires authentication and must not include full sensitive financial details in the subject line.

Add a daily reconciliation job that detects missed reminder deliveries and exposes failures in Admin. Never mark a reminder sent merely because a queue job was created.

Billing and SaaS payments

Razorpay is only for Due’s own SaaS subscription. It must never be used to pay a user’s bills or provider commitments. Verify Razorpay webhook signatures, make webhook processing idempotent, reconcile subscription state periodically, handle retries/cancellations/refunds, and keep the server as the source of entitlement truth. Do not unlock Plus solely from a client-side success callback.

Offer intelligence operations

Public offer refreshes must run through a scheduled worker with source-specific cadence, request timeouts, rate limits, parser versioning, content hashing, and manual review for price/eligibility/expiry changes. A failed refresh must not erase the last known good observation. Show last successful check, not only last attempted check.

Add a stale-data policy: an offer that exceeds its freshness window becomes unknown or active—verify; it must not remain a confident active recommendation indefinitely. Provide a change review screen and an audit trail for every status transition.

Observability and launch monitoring

Add structured logs with correlation IDs, metrics, traces or equivalent request timing, queue depth, Gmail scan failures, inbound email failures, OCR failures, notification delivery failures, payment webhook failures, database errors, and offer-refresh failures. Redact financial content and secrets before logging.

Create /health/live, /health/ready, and a protected /health/integrations view. Readiness must check database, queue, encryption configuration, SMTP, inbound email, OAuth configuration, storage, and billing configuration separately. A missing optional integration must show not configured, not make the whole app appear healthy.

Configure error tracking with privacy-safe payloads, uptime monitoring, alert thresholds, and an incident runbook. Add rate-limit and abuse alerts for login, Gmail scans, forwarding, uploads, and webhook endpoints.

Release gates to add

Do not call the product commercially launched unless all of these are true:

-   production privacy notice, terms, grievance contact, deletion policy, and subprocessor disclosure are populated;

-   database backup and restore have been tested;

-   async queue retry/dead-letter paths have been tested;

-   Gmail OAuth mode and Google verification status are visibly truthful;

-   Postmark/Mailgun signature verification and alias routing have been tested with a real inbound message;

-   raw email/document retention and deletion have been tested;

-   notification delivery has been verified, not merely queued;

-   Razorpay webhook reconciliation has been tested in test mode;

-   security headers, CORS, CSRF, SSRF, rate limits, secret scanning, and dependency scans pass;

-   health endpoints and dashboards are live;

-   rollback and incident procedures are documented;

-   all third-party credentials, DNS records, OAuth redirect URIs, webhook URLs, and Render environment variables are verified in production;

-   the final smoke test proves the complete path: sign in → connect/forward/upload → extract → review → confirm → create reminder → deliver reminder → export/delete.
