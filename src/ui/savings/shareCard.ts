/**
 * "Share my number": one plain sentence with two rounded figures. No merchant names, no account details, no
 * promise. The caller shows it before anything leaves the device.
 */
export function buildShareText(yearlyInr: number, foundMonthlyInr: number): string {
  const rs = (n: number) => `Rs ${Math.round(n).toLocaleString('en-IN')}`;
  const round = (n: number) => (n >= 1000 ? Math.round(n / 100) * 100 : Math.round(n / 10) * 10);
  const parts = [`My recurring bills come to about ${rs(round(yearlyInr))} a year.`];
  if (foundMonthlyInr > 0)
    parts.push(`Due shows ${rs(round(foundMonthlyInr))} a month I could look at.`);
  parts.push('Nothing else is shared. Try it free at https://due.karigarai.com');
  return parts.join(' ');
}

/** Monthly cost of repeat payments found in a statement: about, from the average of each. */
export function monthlyOutlay(
  items: { averageInr: number; cadence: 'monthly' | 'quarterly' | 'yearly' }[],
): number {
  return items.reduce(
    (n, c) =>
      n +
      (c.cadence === 'monthly'
        ? c.averageInr
        : c.cadence === 'quarterly'
          ? c.averageInr / 3
          : c.averageInr / 12),
    0,
  );
}
