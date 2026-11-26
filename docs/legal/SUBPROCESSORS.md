# Subprocessors — Due by KAI

> DRAFT. Entries marked **confirm** must be verified against the live configuration before publishing. Mirror this list into Admin → Legal details → Subprocessors (name, purpose, region; the app shows only those three fields).

**Last updated:** [EFFECTIVE DATE]

| Name | Purpose | Data involved | Region | Status |
| --- | --- | --- | --- | --- |
| Render Services, Inc. | Hosting of web app, API, worker and PostgreSQL database | Account data, synced data (encrypted), logs | Singapore (planned; **confirm** current region) | Confirm |
| Amazon Web Services (AWS SES) | Sending sign-in links, reminders, invites; receiving forwarded email [confirm inbound path] | Email address, message content of service emails | ap-south-1 Mumbai (**confirm**) | Confirm |
| AWS (India-region log store, e.g. S3 with object lock) | Write-once security/audit log storage (CERT-In) | Redacted logs, audit rows (no document or mail content) | India (planned) | Planned, confirm |
| Google LLC (Gmail API, Google sign-in/OAuth) | Read-only Gmail connection, only if you enable it | Gmail messages you allow us to read, Gmail address, OAuth tokens (encrypted) | Google global infrastructure | Only if Gmail is enabled; confirm |
| Cashfree Payments India Pvt. Ltd. | Subscription payments (UPI AutoPay/cards) | Email, mobile (if required), plan, payment status; card/UPI details stay with Cashfree | India | Only when paid plans start; confirm |
| Razorpay Software Pvt. Ltd. | Subscription payments (alternative gateway) | Same as above | India | Only when paid plans start; confirm |
| Functional Software, Inc. (Sentry) | Error reports, with request bodies, users, mail, document content and amounts scrubbed before sending | Technical error data | [US/EU — confirm] | Only if `SENTRY_DSN` is set; confirm |
| [Backup storage provider, e.g. S3-compatible bucket] | Encrypted database backups, 30 days | Encrypted dumps | [confirm] | Confirm |
| [Other: customer-support tool, domain/email hosting (Google Workspace for karigarai.com)] | Replies to support mail | Your messages to us | [confirm] | Confirm |

Not used: advertising networks, analytics SDKs, social pixels, data brokers.

We bind processors by contract to confidentiality and security. We will update this page [30] days before adding a processor that handles personal data, and signed-in users can write to [GRIEVANCE EMAIL] with questions.
