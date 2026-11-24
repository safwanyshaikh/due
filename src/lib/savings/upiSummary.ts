/** UPI-app statement (Google Pay) summary: which payments went on credit cards. */
import { parseStatementText } from './statement';
import { leadingDate } from './statement';
import type { UpiStatementSummary } from './types';

const r2 = (n: number) => Math.round(n * 100) / 100;

export function parseUpiStatementSummary(text: string): UpiStatementSummary | null {
  const lines = parseStatementText(text, 'bank').filter(
    (l) =>
      l.paidBy !== undefined || /^(Paid to|Received from|Self transfer|Top-up)/.test(l.narration),
  );
  if (!lines.length) return null;
  const period =
    /statement\s+period\s*\n?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*-\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i.exec(
      text,
    );
  const months = new Set(lines.map((l) => l.date.slice(0, 7))).size || 1;
  const byCard = new Map<string, number>();
  for (const l of lines)
    if (
      l.amountInr > 0 &&
      l.paidBy &&
      /credit\s+card/i.test(l.paidBy) &&
      !l.selfTransfer &&
      l.lineKind !== 'wallet_topup'
    ) {
      const key = l.paidBy.replace(/^UPI\s+Lite\s*\|\s*/i, '').trim();
      byCard.set(key, (byCard.get(key) ?? 0) + l.amountInr);
    }
  return {
    app: /Google\s+Pay/i.test(text) ? 'Google Pay' : 'UPI app',
    periodFrom: period ? (leadingDate(period[1])?.iso ?? null) : null,
    periodTo: period ? (leadingDate(period[2])?.iso ?? null) : null,
    creditCardSpend: [...byCard.entries()].map(([paidBy, total]) => ({
      paidBy,
      last4: /(\d{2,4})\s*(?:\||$)/.exec(paidBy)?.[1] ?? null,
      totalInr: r2(total),
      months,
    })),
  };
}
