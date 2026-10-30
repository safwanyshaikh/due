=== 1e7cda52-Claude_Code_Prompt_Add_a_Due__Offer_Intelligence_Module_to_the_Calm_Tile_UI_App.docx
Claude Code Prompt: Due Offer Intelligence, No-Auth Intake, and Relay

Modify the real Due application, not a static HTML mockup. Preserve the calm tile UI, but add a production-ready architecture path for household accounts, document intake, forwarded email intake, reminders, and shared public offer intelligence.

Product boundary

Due is a planning and verification app. It does not pay, recharge, activate, redeem, cancel, pause, migrate, port, create mandates, capture OTPs, perform KYC, or accept partner terms. All final provider actions are user-controlled handoffs.

First-use intake choices

Do not force login before value. The first empty state must show four equal paths:

-   Add manually

-   Upload a bill or sanction letter

-   Forward a subscription email

-   Sign in for sync and reminders

Explain: No connection needed. Bring one bill, letter, or email. Due will organise it and you decide what to keep.

Sign-in must be clearly valuable, not coercive. It enables cross-device sync, backup, reminders, forwarding history, household sharing, and recovery. Manual entry and one-document review must remain usable without authentication.

Upload flow

The real backend must support PDF, JPG, PNG, and common document formats. If the current environment has no OCR/backend, implement a polished upload state with mock extraction and a clearly labelled backend-required state—never pretend the upload is live.

After upload, show filename/preview and an editable review card. Extract only provider, commitment type, amount, currency, EMI, interest rate when present, tenure, due/renewal date, trial expiry, benefit, and reference label. Give every field a confidence state. Actions: Edit, Confirm, Ignore, Delete document, and Export structured record. Nothing is saved as an active commitment until user confirmation.

Handle documents as sensitive financial data. Use encrypted transport, malware scanning, short raw-file retention, immediate delete, field minimisation, and redaction guidance for Aadhaar, PAN, full card numbers, CVV, UPI PIN, bank passwords, signatures, and unnecessary addresses/identifiers. Never use sanction letters for lending, underwriting, credit scoring, or general AI training without separate consent. Add local-only parsing where technically available.

Forward-one-email flow

Give a signed-in user or temporary intake session a unique alias such as u7k2mq4xdzfpa@inbox.due.app (`u` + 12 base32 characters, about 60 bits; 5-character aliases issued before go-live keep routing). Never use one shared mailbox and route only by sender email. Route by unique alias/token, message ID, sender/domain, and normalized fingerprint.

The user forwards one bill, renewal, trial, recharge, offer, card, loan, school-fee, or utility email. Due extracts provider, service, amount, billing cycle, renewal date, trial end, benefit, expiry, sender/domain, and source links. Show Review before saving with Save, Edit, Ignore, and Delete.

Sender identity alone is not proof. Keep the candidate private and unverified until user confirmation or an authoritative public-source match. Do not click links, reply, activate, redeem, pay, cancel, or modify provider accounts. Add Pause intake, Rotate address, Export structured record, Delete raw message, and retention explanation.

SMS, WhatsApp, SIM

MVP: no broad SMS permission. Support manual entry and sharing one selected SMS. Do not request a SIM, OTP, bank password, KYC, card number, CVV, UPI PIN, or mailbox-wide access. Do not read personal WhatsApp history or scrape WhatsApp Web. Future WhatsApp Business intake may accept a message deliberately sent to Due after opt-in, but it is not a private-chat scanner.

Data model

Implement typed models equivalent to:

  type IntakeType = 'manual' | 'document' | 'forwarded_email' | 'shared_sms';

  type ReviewStatus = 'needs_review' | 'confirmed' | 'ignored' | 'deleted' | 'unreadable';

  type OfferStatus = 'active' | 'active_verify' | 'expired' | 'conflicting' | 'unknown';

  interface UserEvent {

  id: string;

  userId?: string;

  temporarySessionId?: string;

  intakeType: IntakeType;

  messageFingerprint?: string;

  sourceDomain?: string;

  extractedFields: Record<string, unknown>;

  confidence: Record<string, number>;

  reviewStatus: ReviewStatus;

  rawRetentionUntil?: string;

  createdAt: string;

  }

  interface OfferRecord {

  offerId: string;

  provider: string;

  productFamily: string;

  name: string;

  benefitType: 'recurring_entitlement'|'one_time_reward'|'trial'|'bundle'|'capability';

  price?: number;

  billingPeriod?: string;

  benefitValue: Record<string, unknown>;

  sourceUrls: string[];

  observedAt: string;

  officialStartAt?: string;

  officialEndAt?: string;

  lastConfirmedAt: string;

  computedStatus: OfferStatus;

  confidence: 'high'|'medium'|'low';

  notes: string[];

  }

Keep PublicOfferCatalog separate from UserServiceRecord, UserEvent, and OfferMatch. Reuse one normalized public observation for multiple users without exposing any user’s document, email, phone number, or eligibility.

Offer intelligence UI

Keep Due & Offers calm and non-promotional. Show provider, benefit, eligibility conditions, last checked time, expiry/unknown expiry, status, and official verification link. Use “Possible benefit to verify,” “Last checked,” and “You remain in control.” Do not use “guaranteed saving,” “redeem now,” or “buy now.”

Auth and security

Implement household accounts separately from the admin console. Support passwordless email/magic link or secure password auth, session expiry, rate limiting, password reset, account export, account deletion, consent records, audit logging, and encrypted secrets. Use a real database for synced household data. Keep no-auth temporary intake isolated and expire it unless the user signs in or exports it.

Tests and delivery

Test: anonymous manual entry; anonymous document review; field confidence; delete-before-save; sensitive-field redaction; unique forwarding alias; duplicate message fingerprint; cross-user privacy separation; raw retention expiry; public-catalog reuse; conflict/expiry status; reminder creation; export/delete; no payment or provider mutation endpoints; responsive first viewport; keyboard/touch targets; reduced-motion tactile interaction.

Before completion, run formatter, type checker, linter, tests, and production build. Report changed files, migrations, environment variables, deployed endpoints, test results, known limitations, and explicitly state which integrations are live versus placeholders. Do not claim email forwarding, OCR, auth, or sync is live unless the deployed backend has been tested end to end.
=== f395d3b8-Due_Offer_Intelligence_moat_and_Due_Relay_strategy.docx
Due Offer Intelligence and No-Auth Intake Strategy

Research date: 30 October 2026, India/IST.

Due should not force users to connect a bank, Gmail account, SMS inbox, or provider account before they receive value. The strongest onboarding model is progressive trust: manual entry first, upload one document or forward one email next, and optional account sync later.

Product moat

Due is not only a subscription list. It connects four things: what the user pays, when it is due, what the plan may already include, and what the user should verify before paying separately. The moat is a source-linked, time-aware Offer Intelligence catalog that records provider, plan, benefit, eligibility, expiry, source, last-checked time, and confidence.

The public catalog is shared across users. Personal plan details, forwarded emails, documents, phone numbers, and eligibility remain private to each user. If two users forward the same campaign, Due reuses the normalized public observation instead of researching it again.

Competitive learning

Rocket Money wins with account linking, recurring-charge detection, cancellation help, bill negotiation, alerts, and a strong savings promise. Its public materials claim 10M+ members and 5M+ subscriptions cancelled, but its model is US-centric and requires account connectivity for its strongest automation. Due should not copy its broad dashboard; it should own India-specific commitments, offer discovery, reminders, and explainable verification.

Copilot and Monarch show that premium finance products sell calm clarity, privacy, approval before automation, household value, and clear ongoing insight—not merely charts. Bobby demonstrates the appeal of a focused subscription list and quick manual entry. PocketGuard demonstrates the value of an upcoming-bill view and a single actionable summary.

In India, Nance, KeepMyPlans, and FinArt show demand for subscription/expense tracking, but their public products differ in automation, platform, pricing, and privacy. FinArt is more India-native with SMS/app-notification expense capture; KeepMyPlans is simple and manual; Nance presents broader money tracking. Due can differentiate with email/document intake, offer matching, UPI/card/OTT context, renewal-risk reminders, and a better first viewport.

No-auth intake is a validated product choice

The first screen should offer four paths:

-   Add manually

-   Upload a bill or sanction letter

-   Forward a subscription email

-   Sign in for sync and reminders

The user can get a useful result without authentication. Authentication becomes valuable because it enables cross-device sync, backup, reminders, forwarding history, household sharing, and recovery.

Upload one document

Accept a PDF, JPG, PNG, or document containing a bill, loan sanction letter, EMI schedule, card statement, school-fee notice, recharge receipt, or subscription invoice. Extract only planning fields: provider, commitment type, amount, EMI, interest rate if present, tenure, due date, renewal date, trial end, and benefit details.

Show an editable review card with confidence for each field. The document is not saved as a commitment until the user confirms it. Provide Edit, Confirm, Ignore, Delete, and Export structured record actions.

Sensitive documents require encrypted transport, malware scanning, short raw-file retention, immediate deletion, and redaction/minimisation of Aadhaar, PAN, full card numbers, CVV, UPI PIN, bank passwords, signatures, and unrelated personal information. Do not use sanction letters for lending, underwriting, credit scoring, or general AI training without separate explicit consent. Browser-local parsing is preferable for the first prototype; server OCR requires a disclosed vendor and data-flow review.

Forward one subscription email

Give a user or temporary intake session a unique alias such as u7k2mq4xdzfpa@inbox.due.app (`u` + 12 base32 characters, about 60 bits; 5-character aliases issued before go-live keep routing). Do not use one shared mailbox and identify customers only from sender email. Route using the unique alias/token, message ID, sender/domain, and normalized fingerprint.

The user forwards only the relevant bill, renewal, trial, recharge, offer, card, lender, school, or utility email. Due extracts provider, service, amount, billing cycle, renewal date, trial end, benefit, offer expiry, sender/domain, and source links. It then shows Review before saving with Save, Edit, Ignore, and Delete.

Sender identity alone is not proof. Raw email retention must be short and visible. The user can pause intake, rotate the alias, export structured records, or delete raw messages. Due never clicks links, replies, activates, redeems, pays, cancels, or modifies provider accounts.

SMS, WhatsApp, and SIM boundaries

MVP should not read SMS automatically. Support manual entry or sharing one selected SMS. Android broad SMS access needs separate Google Play and legal review; SMS Retriever is for app-specific verification, not general financial-message history. iPhone should use share-sheet/manual entry and email forwarding. Do not read personal WhatsApp history or scrape WhatsApp Web. A future WhatsApp Business intake may accept one message deliberately sent by the user after opt-in, but it is not a private-chat scanner. Do not ask for a SIM, OTPs, bank password, KYC, or carrier forwarding.

Shared research brain

Use these records:

-   PublicOfferCatalog: canonical provider offer, source URLs, terms, observed time, status, expiry, and evidence snapshot.

-   ProviderParserTemplate: versioned extraction rules by sender/domain and message class.

-   UserServiceRecord: personal plan, bill, device, circle, renewal, or claim-card assertion.

-   UserEvent: private forwarded-message or uploaded-document candidate, confirmation, ignore/delete decision, and fingerprint.

-   OfferMatch: public offer plus private user record plus missing/confirmed eligibility.

-   RefreshJob: source, cadence, last checked, changes, errors, and review state.

A public offer should have provider, product family, SKU, benefit type, price, billing period, benefit value, geography, source URLs, observed time, official start/end, last confirmed time, page status, terms status, computed status, confidence, and notes.

Use statuses expired, conflicting, active_verify, and unknown. An expired official end date or unavailable terms wins over a still-visible landing page. A current public page with unresolved account, plan, address, or selected-user eligibility is active_verify. Never infer expiry from page visibility or present an old press release as current.

Offer examples to seed and verify

Jio plan pages document plan-specific OTT benefits, JioFiber/AirFiber bundles, JioAICloud, and partner rewards. The Jio Gemini landing page and official terms conflict, so it must not be shown as a guaranteed active offer. Airtel documents postpaid, Fiber, Adobe Express, cloud/OTT, roaming, and partner benefits that depend on plan, tenure, address, device, or claim card. Vi documents OTT packs, complimentary OTT on some recharge denominations, and volatile payment campaigns. Amazon and Google document plan tiers, third-party billing ownership, trials, and renewal rules. Due should show source, last checked time, conditions, and a provider verification handoff rather than promise savings.

User-facing service card

After confirmation, show amount, next charge/date, documented included benefits, unconfirmed benefits, possible bundle or lower-cost option, trial/renewal risk, reminder date, source, last checked time, and Verify in official provider app/site. Use “Possible benefit to verify,” not “guaranteed saving.”

Rollout

MVP: manual entry, upload-review UI with mock extraction, unique-intake UI placeholder, seeded offer catalog, reminders, source/status display, and export/delete. No broad inbox or SMS access.

Closed beta: real household authentication, unique forwarding alias, inbound email webhook, generic parser, user confirmation queue, encrypted short-retention storage, provider templates, shared catalog reuse, and cross-device sync.

Later: optional narrowly scoped Gmail connection, Android share/SMS candidate intake after policy review, compliant WhatsApp Business intake, licensed provider feeds, and partnerships. Do not build payment execution, SIM interception, full inbox mining, or an offer marketplace.

References
