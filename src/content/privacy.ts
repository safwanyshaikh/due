export const PRIVACY_SUMMARY = {
  heading: 'Privacy summary (draft for the invite-only beta)',
  banner:
    'Draft, not final legal text. A lawyer in India must review the real terms and privacy notice before any public launch.',
  points: [
    'Where your data lives: in this browser on this device (local storage). If you sign in and turn on backup, a copy is stored with your Due account so it can sync to your other devices; you can turn that off, export it or delete the account. Without an account, the app only downloads the public offers list and plan prices from Due’s server; those requests carry none of your data.',
    'What we store: the commitments you type in or import (provider, nickname, amounts, dates, notes), your limits, seasonal plans, reminder settings and billing-email labels.',
    'Documents you upload are read in this browser. The file is never uploaded to Due’s server in this release; only the fields you confirm are kept.',
    'Forwarded emails: only messages you deliberately forward to your personal Due address are read. Raw messages are kept for a short retention period and you can delete them sooner.',
    'What we never ask for or store: card numbers or security codes, UPI PINs, bank passwords, PAN, Aadhaar, loan-account logins, raw inbox or chat contents, or full bank statements. Text that looks like one of these is masked before anything is extracted.',
    'Billing-email labels only help you organise records. Due does not read that inbox.',
    'School fees: use a generic label such as “School fees”. Do not enter a child’s name, birthdate, student ID or school login.',
    'Totals are estimates based on what you entered. Statuses such as “pause confirmed by you” are your own notes; they are not verified with any provider.',
    'No payments, no loan offers, no data sale, and no connection to your bank, Gmail, SMS or WhatsApp.',
    'Anonymous usage events (for example “first item added”) help us improve Due. They carry no names, amounts or text, and you can turn them off in Settings.',
    'You can export your data, correct it, or delete everything from Settings at any time.',
  ],
  contact: 'Grievance / support contact: [to be added: name, email, response time]',
};

export const ESTIMATE_NOTE =
  'Totals come from what you entered. Some amounts may be estimates, and nothing here is verified with a lender, school, merchant or card issuer.';

export const LABEL_NOTE = 'Organisation only — Due does not read this inbox.';

export const NO_PAYMENT_NOTE =
  'We never pay, borrow, cancel or pause anything for you. You act with your own providers.';

/** Exact copy required next to the email/forward option. */
export const EMAIL_INGESTION_COPY =
  'Import receipts, not your inbox. Due reads only messages you explicitly forward or connect, extracts merchant/amount/date/link, and shows every field for approval before saving. It does not read unrelated mail, bank passwords, card numbers, UPI PINs, or full inbox history. You can delete imported data and disconnect the source anytime.';

export const INTAKE_LINE =
  'No connection needed. Bring one bill, letter, or email. Due will organise it and you decide what to keep.';

/** Permission preview for email forwarding: what Due can and cannot see. */
export const FORWARD_PERMISSIONS = {
  can: [
    'Only the emails you forward to your personal Due address',
    'From those: merchant, amount, date, billing cycle and links',
    'The sender’s domain, to help match the merchant',
  ],
  cannot: [
    'Your inbox, other emails or past mail',
    'Bank passwords, card numbers or UPI PINs',
    'Anything you didn’t forward',
  ],
};

export const FORWARD_RETENTION =
  'Raw forwarded messages are kept only for a short retention period so you can check the extraction, then deleted automatically. Delete any raw message sooner from the review queue. Reviewed fields stay until you delete them.';

export const UPLOAD_NOTE =
  'Your file is read in this browser. It is never uploaded to Due’s server in this release. Card numbers, PAN, Aadhaar, OTPs and similar details are masked before anything is extracted.';

/** Version of the consent text shown before creating a forwarding address. */
export const EMAIL_INTAKE_CONSENT_VERSION = 'email-intake-2026-10';
export const TELEMETRY_CONSENT_VERSION = 'telemetry-2026-10';
/** Consent text versions for the account's backup/sync and email reminders switches. */
export const SYNC_BACKUP_CONSENT_VERSION = 'sync-2026-10';
export const REMINDERS_EMAIL_CONSENT_VERSION = 'reminders-2026-10';
