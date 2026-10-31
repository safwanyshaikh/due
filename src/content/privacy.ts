export const PRIVACY_SUMMARY = {
  heading: 'Privacy summary',
  banner:
    'A short summary. The full Privacy notice, Terms, Deletion policy, Subprocessors and Grievance contact are under Settings → Legal.',
  points: [
    'Where your data lives: in this browser on this device (local storage). If you sign in and turn on backup, a copy is stored with your Due account so it can sync to your other devices; you can turn that off, export it or delete the account. Without an account, the app only downloads the public offers list and plan prices from Due’s server; those requests carry none of your data.',
    'What we store: the commitments you type in or import (provider, nickname, amounts, dates, notes), your limits, seasonal plans, reminder settings and billing-email labels.',
    'Documents and photos you upload are read in this browser (photos with on-device text recognition). The file is never uploaded to Due’s server; only the fields you confirm are kept.',
    'Gmail is optional and read-only. If you connect it, Due searches only for billing, renewal, subscription, loan, card, recharge, invoice and trial messages, and cannot send, delete, reply, pay, cancel or change anything. Disconnect at any time.',
    'Forwarded emails: only messages you deliberately forward to your personal Due address are read. Raw messages are kept for a short retention period and you can delete them sooner.',
    'What we never ask for or store: card numbers or security codes, UPI PINs, bank passwords, PAN, Aadhaar, loan-account logins, raw inbox or chat contents, or full bank statements. Text that looks like one of these is masked before anything is extracted.',
    'Billing-email labels only help you organise records. Due does not read that inbox.',
    'School fees: use a generic label such as “School fees”. Do not enter a child’s name, birthdate, student ID or school login.',
    'Totals are estimates based on what you entered. Statuses such as “pause confirmed by you” are your own notes; they are not verified with any provider.',
    'No payments, no loan offers, no data sale, and no connection to your bank, SMS or WhatsApp.',
    'Anonymous usage events (for example “first item added”) help us improve Due. They carry no names, amounts or text, and you can turn them off in Settings.',
    'You can export your data, correct it, or delete everything from Settings at any time.',
  ],
  contact: 'Grievance and support contact: see Settings → Legal → Grievance contact.',
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
  'Your file is read in this browser, and photos are read with on-device text recognition. Nothing is uploaded to Due’s server. Card numbers, PAN, Aadhaar, OTPs and similar details are masked before anything is extracted or shown.';

/** Exact Gmail consent copy (LAUNCH_SPEC). Shown with the scope list before redirecting to Google. */
export const GMAIL_CONSENT_COPY =
  'Due searches only for relevant billing, renewal, subscription, loan, card, recharge, invoice, and trial messages. Due cannot send, delete, reply, pay, cancel, or change anything in your Gmail.';

/** Plain-language meaning of each Google scope Due may request. */
export const GMAIL_SCOPE_LABELS: Record<string, string> = {
  'https://www.googleapis.com/auth/gmail.readonly':
    'Read your Gmail messages (read-only). Needed to read billing details in a message; metadata-only access cannot see the message text.',
  openid: 'Confirm it is you (OpenID)',
  email: 'See your Gmail address, to label this connection',
  'https://www.googleapis.com/auth/userinfo.email':
    'See your Gmail address, to label this connection',
};

/** Version of the consent text shown before creating a forwarding address. */
export const EMAIL_INTAKE_CONSENT_VERSION = 'email-intake-2026-10';
export const TELEMETRY_CONSENT_VERSION = 'telemetry-2026-10';
/** Consent text versions for the account's backup/sync and email reminders switches. */
export const SYNC_BACKUP_CONSENT_VERSION = 'sync-2026-10';
export const REMINDERS_EMAIL_CONSENT_VERSION = 'reminders-2026-10';
