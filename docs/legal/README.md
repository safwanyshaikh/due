# Legal pages for Due by KAI

**Drafts, not legal advice — have an Indian tech/privacy lawyer review before publishing.**

Operator: Safco Skill Academy Private Limited (brand KarigarAI), https://due.karigarai.com. Drafted 2026-11-26 from the repo docs (SECURITY, SECURITY_AUDIT_2026-11-25, INTAKE/SAVINGS specs, GOOGLE_VERIFICATION, PAYMENTS, EMAIL_SETUP, MOBILE, STORE_LISTING, `src/content/privacy.ts`, `server/src/legal/`).

## Files
PRIVACY_POLICY.md · TERMS.md · REFUND_CANCELLATION.md · DELIVERY_POLICY.md · CONTACT.md · DATA_DELETION.md · DPDP_NOTICE.md (EN + HI) · SUBPROCESSORS.md · COOKIES.md

## Before publishing
1. Fill every `[BRACKET]` (registered address, CIN, grievance officer, DPO, support email/phone, effective date, dormant-account rule, prices/days). Nothing here is invented; no PAN, GSTIN or bank details belong in these files.
2. Resolve every "confirm" (regions, SES inbound path, Sentry, nomination process, retention values) against production config.
3. Load the finished Markdown into Admin → Legal details: `legal.privacy_policy_md` = PRIVACY_POLICY, `legal.terms_md` = TERMS, `legal.deletion_policy_md` = DATA_DELETION, `legal.subprocessors` = table rows (name, purpose, region). Set entity name, address, grievance fields, support email, incident contact, effective date (YYYY-MM-DD).
4. The server rejects placeholder text (`server/src/legal/index.ts`: "draft", "tbd", "placeholder", "your company", example domains), so remove the DRAFT banners and brackets before saving or the legal gate stays incomplete.
5. Publish REFUND_CANCELLATION, DELIVERY_POLICY, CONTACT and COOKIES as public pages (these four have no Admin field yet; they need a site route or static page), plus link all pages in the footer.
6. Where the code and a draft disagree, the code wins; fix the draft. Known open items from the 25 Nov audit that the text assumes will ship: India log store, end-to-end sync, nomination, breach notices, 18+ declaration, analytics opt-in.

## Requirements checklist
| Requirement | Source | Satisfied by |
| --- | --- | --- |
| Privacy Policy page | Cashfree, Razorpay, Play, App Store, IT Act/SPDI r.4 | PRIVACY_POLICY.md |
| Terms and Conditions page | Cashfree, Razorpay | TERMS.md |
| Cancellation and Refund policy | Cashfree, Razorpay, E-Commerce Rules | REFUND_CANCELLATION.md |
| Shipping/Delivery policy (digital: "no physical delivery") | Razorpay (listed), Cashfree (not confirmed required) | DELIVERY_POLICY.md |
| Contact Us with address, email, phone | Cashfree, Razorpay, E-Commerce Rules r.4 | CONTACT.md |
| Pricing details page | Razorpay | Not drafted; use app Plans / PRICING.md after beta |
| About us page | Razorpay | Not drafted (marketing page) |
| DPDP notice: itemised data, purpose, rights, withdrawal, complaint route to Board | DPDP Act s.5, Rule 3 | DPDP_NOTICE.md, PRIVACY_POLICY.md s.3-4, 10-11 |
| Consent per purpose, withdrawal as easy as giving | DPDP Act s.6 | DPDP_NOTICE.md (versions match app constants) |
| Rights: access, correction, erasure, grievance, nomination | DPDP Act s.11-14 | PRIVACY_POLICY.md s.10, DATA_DELETION.md |
| Grievance redressal, within 90 days max | DPDP Rule 14(3); IT Rules (Grievance Officer) | PRIVACY_POLICY.md s.11, CONTACT.md, TERMS.md s.15 |
| Children / 18+ only | DPDP s.9 | PRIVACY_POLICY.md s.12, TERMS.md s.2, DPDP_NOTICE.md |
| Breach notice to Board and users; security safeguards; retention | DPDP s.8, Rules | PRIVACY_POLICY.md s.8-9 |
| CERT-In logs (180 days, India), incident reporting | CERT-In Directions 2022 | PRIVACY_POLICY.md s.8-9, SUBPROCESSORS.md |
| SPDI Rules: consent, purpose, disclosure, grievance officer | IT Act/SPDI 2011 | PRIVACY_POLICY.md |
| Subprocessor/third-party disclosure | DPDP, Play, SPDI | SUBPROCESSORS.md |
| Google API Limited Use disclosure | Google API Services User Data Policy; OAuth verification | PRIVACY_POLICY.md s.5, DPDP_NOTICE.md s.4 |
| Account deletion in app and on the web | Play (Data safety form), App Store 5.1.1(v) | DATA_DELETION.md |
| Data safety / App Privacy answers | Play, Apple (manifest) | Not drafted; derive from PRIVACY_POLICY.md s.3 and SUBPROCESSORS.md |
| Cookies/local storage disclosure | Good practice; DPDP notice | COOKIES.md |
| RBI: information-only, no lending/payments | RBI rules | TERMS.md s.3, PRIVACY_POLICY.md s.2, s.15 |
| Consumer Protection (E-Commerce) Rules: seller details, grievance officer, 48h ack / 1 month resolution | E-Commerce Rules 2020 | TERMS.md s.15-16, CONTACT.md |
| GST invoices/tax wording | GST law | TERMS.md s.6, REFUND_CANCELLATION.md s.6 |

## Sources (searched 2026-11-26)
- DPDP Rules 2025 (notified 13-14 Nov 2025; Rule 3 notice, Rule 14(3) 90-day grievance cap; Rules 3 and 5-16 commence 18 months after publication, around May 2027; Rule 4 after 1 year): [PIB](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf), [SCC Online](https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/), [Mondaq](https://www.mondaq.com/india/data-protection/1708164/digital-personal-data-protection-rules-2025-notified), [Tribune](https://www.tribuneindia.com/news/business/govt-notifies-digital-personal-data-protection-rules-rollout-in-phases-specified-obligations-for-data-fiduciaries). Nomination timing and process were NOT confirmed: check the Gazette text.
- Razorpay website pages (About, Contact, Pricing, Terms, Privacy, Cancellation/Refund; Shipping in some regions; one FAQ says policies are no longer required at onboarding, so re-check): [Razorpay docs](https://razorpay.com/docs/payments/dashboard/account-settings/business-website-details), [Razorpay blog](https://razorpay.com/blog/payment-gateway-compliance/)
- Cashfree (Contact Us, Terms, Refunds and Cancellations; Privacy Policy; shipping not confirmed): [Security docs](https://www.cashfree.com/docs/security.md), [Account FAQ](https://www.cashfree.com/docs/help/account/faq)
- Apple 5.1.1(v): [Apple](https://developer.apple.com/support/offering-account-deletion-in-your-app); Google Play deletion: [Google](https://support.google.com/googleplay/android-developer/answer/13327111). The Play requirement for a web deletion URL was only seen in a third-party source: confirm in Play Console.
- Not searched (from repo docs and general knowledge, verify): CERT-In Directions 2022, IT Act/SPDI Rules 2011, E-Commerce Rules 2020, RBI refund timelines (T+5), Google Limited Use wording (see `docs/production/GOOGLE_VERIFICATION.md`).
