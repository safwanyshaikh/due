/** Light guard so users don't paste things this app must never hold. */
export function looksSensitive(text: string): string | null {
  if (!text) return null;
  const digitsOnly = text.replace(/[\s-]/g, '');
  if (/\d{13,19}/.test(digitsOnly))
    return 'This looks like a card or account number. Please remove it.';
  if (/\b[A-Za-z]{5}\d{4}[A-Za-z]\b/.test(text)) return 'This looks like a PAN. Please remove it.';
  if (/\b\d{4}\s\d{4}\s\d{4}\b/.test(text))
    return 'This looks like an Aadhaar number. Please remove it.';
  return null;
}

const BLOCKED_HEADERS = [
  'card_number',
  'cardnumber',
  'cvv',
  'pan',
  'aadhaar',
  'aadhar',
  'password',
  'pin',
  'upi_pin',
  'account_number',
  'otp',
];

export function blockedHeader(h: string): boolean {
  return BLOCKED_HEADERS.includes(
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_'),
  );
}
