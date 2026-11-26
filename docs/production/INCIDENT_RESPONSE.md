# Incident response and breach notification

This runbook covers security incidents and personal data breaches at Due. It is written for India: the CERT-In Directions of 28 April 2022 (under section 70B of the IT Act) and the Digital Personal Data Protection Act 2023 with the DPDP Rules 2025. It is not legal advice. Have it reviewed by counsel before launch, and check the current text of the rules, because deadlines and forms change.

## Deadlines at a glance

| Who | What | Deadline | How |
| --- | --- | --- | --- |
| CERT-In | Report of a reportable cyber incident (list below) | **Within 6 hours** of noticing it | Email `incident@cert-in.org.in` with the CERT-In incident reporting form (cert-in.org.in > Reporting). Phone and fax numbers are on the same page. |
| Data Protection Board of India | Intimation of a personal data breach | **Without delay** (do it the same day) | Board's online portal / the address it publishes. |
| Data Protection Board of India | Detailed report: facts, cause, mitigation, who was affected, notices sent | **Within 72 hours** of becoming aware (or longer only if the Board allows it on request) | Same channel. |
| Each affected person | Breach notice in plain language | **Without delay** | Admin console: incident record → draft notice → another owner approves (below). |
| Payment gateway (Razorpay / Cashfree) | If card or payment data could be involved | As their agreement says (usually 24 hours) | Their security contact. |
| Google | If Gmail data or OAuth tokens are involved | Without delay | Google API Services User Data Policy contact; revoke tokens. |

A "reportable" CERT-In incident includes, among others: targeted scanning of critical systems, compromise of systems or data, unauthorised access to IT systems or data, defacement, malicious code (ransomware, malware), attacks on servers (database, mail, DNS), identity theft, spoofing and phishing, data breach and data leak, attacks on cloud and on IoT, and DDoS. When in doubt, report: a late report is a breach of the Directions; an unnecessary one is not.

## Roles

| Role | Who (fill in) | Does |
| --- | --- | --- |
| Incident lead | Founder (default) | Declares the incident, owns the timeline, decides on notices. |
| CERT-In point of contact | Named person, registered with CERT-In; shown as `legal.incident_contact` in Admin > Legal | Sends the 6-hour report and answers CERT-In. CERT-In requires the PoC's name, designation, email, phone and address to be on file with them. |
| Grievance Officer (DPDP) | `legal.grievance_officer_name` / `legal.grievance_email` | Answers affected people; named in every breach notice. |
| Technical responder | Engineer on call | Contains, preserves evidence, rotates secrets, restores. |
| Communications | Founder or delegate | Writes user notices, status page / in-app incident banner. |

Keep a second person able to do each role. Write their phone numbers in the password manager, not here.

## Steps

1. **Notice and declare (T+0).** Write the time you noticed in the incident log (a private doc). Start a timeline. Set the in-app banner: Admin > Incident (`PATCH /api/admin/incident`).
2. **Contain (T+0 to T+1 h).** Depending on the case: revoke admin sessions (Admin > Users > Revoke sessions; reset 2-step), rotate the affected secrets (`SECURITY.md` > Secret rotation), pause intake (rotate `INBOUND_WEBHOOK_SECRET`), disconnect Gmail tokens, restrict the admin console with `ADMIN_ALLOWED_IPS`.
3. **Preserve evidence.** Do not delete logs. The India-region log store (below) is write-once; export the relevant window. Take a database snapshot before any clean-up.
4. **Report to CERT-In (before T+6 h).** Use template A. Send what you know; send updates later.
5. **Assess personal data.** Which accounts, which data types (email, synced items, intake text, Gmail excerpts, payment references), how many people, which period. The audit tables (`audit_log`, `consumer_audit`, `login_events`) and the shipped logs answer most of this.
6. **Tell the Board and the people affected (same day; detailed Board report before T+72 h).** Use templates B and C. Send person notices from the admin console (below).
7. **Recover.** Fix the cause, restore service, confirm with monitoring.
8. **Close.** Post-incident review within 2 weeks: timeline, root cause, what changes. Keep the incident file for at least 5 years.

## Sending breach notices to affected accounts

The tool cannot be used by one person as a phishing channel (round-2 finding M-B):

1. **Open an incident record** (admin or owner): `POST /api/admin/incident/records { "incidentRef": "INC-2026-11-01", "title": "..." }`. Notices need an open record; close it with `POST /api/admin/incident/records/INC-2026-11-01/close`.
2. **Draft** (admin or owner): `POST /api/admin/incident/notices { "incidentRef": "...", "fields": { "discoveredOn", "whatHappened", "dataAffected", "whatWeDid", "whatYouCanDo" }, "accountIds": [...] }`. The email is a **fixed template**; the fields are short plain text and may not contain links, web or e-mail addresses, phone numbers or markup. Up to 1,000 accounts per draft. The response shows a preview.
3. **Every owner is alerted** (in-app and by email) when a record is opened, a draft is created and a notice is sent.
4. **Approve** (an owner who is **not** the author, with a fresh 2-step code): `POST /api/admin/incident/notices/<id>/approve` (`{ "dryRun": true }` first). Only then is it sent: one email per account, the server adds the reference, the Grievance Officer and the security contact, and says the email has no links and Due never asks for passwords or OTPs.
5. Limits: 10 drafts/approvals an hour; **at most 5,000 breach emails in 24 hours** in total. Accounts already notified for the same reference are skipped. Audit: `incident.opened`, `incident.notice_drafted`, `incident.notify_accounts` (counts only, never addresses). Progress: `GET /api/admin/incident/notices` and `GET /api/admin/incident/notifications?incidentRef=...`.

With a single owner, add a second owner before an incident (Users page) so approval is possible.

## Logs, retention and time (CERT-In)

- **What is logged.** Web and worker logs (pino, JSON) are redacted before they are written: no cookies, tokens, e-mail addresses, amounts or message text (`server/src/observability/logging.ts`). Security audit trails live in the database: `audit_log` (admin actions), `consumer_audit` (account actions), `login_events` (admin sign-ins with IP and user agent).
- **Retention.** Admin sign-in history, `audit_log` and `consumer_audit` are kept **365 days** (CERT-In asks for 180 days), then deleted by `retention.purge`. With `LOG_SINK_URL` set, only rows already shipped are deleted. Shipping waits 5 minutes after a row is written (so no row is skipped while transactions commit) and removes names, labels and titles as well as e-mail addresses and numbers.
- **Kept in India.** Set `LOG_SINK_URL` (and `LOG_SINK_TOKEN`) to ship redacted log lines continuously, and new audit rows every 15 minutes (`audit.ship` job, cursor in the `log_sink.cursor` setting), to a store in India. Recommended: **AWS ap-south-1 (Mumbai)**: an API Gateway HTTP API (or a small Lambda function URL) that checks the bearer token and writes each NDJSON batch to an **S3 bucket with Object Lock in compliance mode, 365-day default retention**, versioning on, SSE-KMS with a key in the same region, a lifecycle rule to delete after 400 days, and bucket access limited to a break-glass IAM role. This copy cannot be changed or deleted, even by an admin, until the retention ends. The app itself is hosted on Render (Oregon, US); this sink is what keeps the CERT-In logs in India. Moving the database to an India region (or to an Indian provider) is tracked separately.
- **Clock (NTP).** CERT-In asks that system clocks be synchronised to the NTP servers of NIC or NPL, or to servers traceable to them. Render hosts run on cloud infrastructure that syncs to its provider's time service (traceable to UTC); every timestamp Due writes is UTC (ISO 8601). For any server Due runs itself, configure `chrony` with `samay1.nic.in`, `samay2.nic.in` and `time.nplindia.org`. The S3 sink adds its own receive timestamps (AWS Time Sync), which give an independent clock for the log trail. Check the drift during each incident drill.
- **Drill.** Twice a year: run a tabletop with these templates, check that the log store has the last 24 hours, and that drafting a notice and approving it with `dryRun` works.

## Templates

### A. CERT-In report (within 6 hours)

> Subject: Cyber security incident report – [Entity name] – [INC ref]
>
> Reporting entity: [legal.entity_name], [legal.address]. Point of contact: [name, designation, phone, email].
> Time noticed (IST): [..]. Time of occurrence (if known): [..].
> Type of incident: [from the CERT-In list, e.g. unauthorised access to systems/data].
> Systems affected: [web application / database / email / cloud account], hosted at [provider, region].
> Description: [what happened, how it was noticed].
> Indicators: [IPs, domains, hashes, user agents, log extracts with timestamps].
> Actions taken: [containment, rotation, isolation].
> Personal data involved: [yes/no/under assessment; types; approximate number of people].
> We will send updates as the investigation progresses.

### B. Data Protection Board (intimation now; detailed report within 72 hours)

> Data Fiduciary: [entity, address, contact]. Reference: [INC ref].
> Nature of the breach: [..]. Extent: [data types, number of Data Principals, period].
> Timing and location: [when it happened, when it was noticed, where the data was].
> Likely impact on Data Principals: [..].
> (Detailed report) Facts and sequence of events; cause; measures taken or proposed to mitigate the risk; findings about the person responsible (if any); remedial steps to prevent recurrence; notices sent to Data Principals (date, number, text).

### C. Notice to each affected person (plain language)

> Subject: Important: a security incident affecting your Due account
>
> On [date] we found that [what happened, in one sentence]. It affected [which of your data: e.g. your email address and the items you backed up]. It did not affect [what was safe].
> What we have done: [contained it, rotated keys, reported to CERT-In and the Data Protection Board].
> What you can do: [e.g. sign out of other devices in Due > Account > Devices; watch for emails pretending to be Due; Due never asks for your password, OTP or bank details].
> Questions: our Grievance Officer [name] at [email]. (The server adds the reference and the contacts automatically.)

## Contacts to keep current

- CERT-In: `incident@cert-in.org.in`, cert-in.org.in (check the reporting page for the current phone numbers and form).
- Data Protection Board of India: the portal and address the Board publishes.
- Render support, AWS (log store) account owner, Google Cloud (OAuth client) owner, SMTP provider, payment gateway security contacts.
