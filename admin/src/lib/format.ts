const istFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

/** Formats a timestamp in India Standard Time, always labelled "IST". */
export function formatIST(value: string | number | Date | null | undefined, empty = 'Never'): string {
  if (value === null || value === undefined || value === '') return empty;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return empty;
  return `${istFormatter.format(d)} IST`;
}

export type FrequencyUnit = 'hours' | 'days';

/** Converts a frequency entered as hours or days into minutes. */
export function frequencyToMinutes(amount: number, unit: FrequencyUnit): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * (unit === 'days' ? 1440 : 60));
}

/** Splits minutes into the friendliest whole unit for editing. */
export function minutesToFrequency(minutes: number): { amount: number; unit: FrequencyUnit } {
  if (minutes > 0 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: 'days' };
  return { amount: Math.round((minutes / 60) * 100) / 100, unit: 'hours' };
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Human interval label. Polling is always described as a schedule. */
export function intervalLabel(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return 'Not scheduled';
  const { amount, unit } = minutesToFrequency(minutes);
  if (unit === 'hours' && amount < 1) return plural(minutes, 'minute');
  return plural(amount, unit === 'days' ? 'day' : 'hour');
}

export function checkedEvery(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return 'Not scheduled';
  return `Checked every ${intervalLabel(minutes)}`;
}

export function humanize(value: string | null | undefined): string {
  if (!value) return '';
  const s = value.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Plain-language description of a source's monitoring status. */
export function sourceStatusText(status: string, lastError?: string | null): string {
  if (status === 'inaccessible' && lastError && /js_only/i.test(lastError)) {
    return 'Source needs a browser (JavaScript-only page)';
  }
  switch (status) {
    case 'active':
      return 'Active';
    case 'failing':
      return 'Failing (retrying with backoff)';
    case 'blocked_robots':
      return 'Blocked by robots.txt';
    case 'inaccessible':
      return 'Source inaccessible';
    case 'disabled':
      return 'Disabled';
    default:
      return humanize(status);
  }
}

export function inaccessibleReason(lastError?: string | null): string {
  if (!lastError) return 'reason not recorded';
  if (/js_only/i.test(lastError)) return 'Source needs a browser (JavaScript-only page)';
  return lastError;
}
