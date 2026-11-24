/**
 * Telecom bills (Jio Postpaid / JioFiber / AirFiber) read on the device: plan, rental, add-ons,
 * usage charges, total, due date, bill period, data used vs plan data, bundled OTT apps.
 * Only printed values are kept; numbers that are not on the bill stay null.
 */
import { leadingDate, parseAmountCell } from './statement';
import type { TelecomBillSummary } from './types';

const MONEY_LINE = /^\d{1,3}(?:,\d{2,3})*\.\d{2}$/;
const DATE_TOKEN = /\b(\d{1,2}-[A-Za-z]{3}-\d{2,4})\b/g;

const iso = (s: string | undefined | null) => (s ? (leadingDate(s)?.iso ?? null) : null);
const r2 = (n: number) => Math.round(n * 100) / 100;

function addOns(text: string): TelecomBillSummary['addOns'] {
  const out: TelecomBillSummary['addOns'] = [];
  const re =
    /Add-?on\s+(Child|Member|Family|Spouse|Parent|Adult|Connection)\b[^\n\d₹]*?(?:Rs\.?|₹)?\s*(\d[\d,]*(?:\.\d{1,2})?)/gi;
  for (const m of text.matchAll(re)) {
    const amt = parseAmountCell(m[2]);
    if (amt !== null && amt > 0)
      out.push({
        label: `Add-on ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}`,
        amountInr: amt,
      });
  }
  return out;
}

function dataUsage(text: string): { used: number | null; plan: number | null } {
  const both = /(\d+(?:\.\d+)?)\s*GB\s*(?:used\s*)?(?:of|out\s+of|\/)\s*(\d+(?:\.\d+)?)\s*GB/i.exec(
    text,
  );
  if (both) return { used: Number(both[1]), plan: Number(both[2]) };
  const used = /Data\s+(?:used|usage|consumed)[^\d\n]{0,20}(\d+(?:\.\d+)?)\s*GB/i.exec(text);
  const plan = /(?:Plan|Total|Shared)\s+data[^\d\n]{0,20}(\d+(?:\.\d+)?)\s*GB/i.exec(text);
  return { used: used ? Number(used[1]) : null, plan: plan ? Number(plan[1]) : null };
}

function usageCharges(text: string): number | null {
  let sum = 0;
  let found = false;
  for (const m of text.matchAll(
    /\b(ISD|International\s+Roaming|IR\s+Usage|Roaming)\b[^\n\d]*?(\d[\d,]*\.\d{2})/gi,
  )) {
    const v = parseAmountCell(m[2]);
    if (v !== null) {
      sum += v;
      found = true;
    }
  }
  return found ? r2(sum) : null;
}

/** Jio Postpaid (Plus) bill, or null. */
export function parseJioPostpaidBill(text: string): TelecomBillSummary | null {
  if (
    !/Jio/i.test(text) ||
    !/Postpaid|Invoice\s+Summary|Current\s+Plan/i.test(text) ||
    /JioFiber|AirFiber/i.test(text)
  )
    return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const plan =
    /^(\d{2,5}\s*-\s*[^\n]+?)\s+Rs\s*\d+\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+to\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/m.exec(
      text,
    );
  const total = /Total\s+Payable\s+(\d[\d,]*\.\d{2})/i.exec(text);
  if (!plan && !total) return null;
  // Header block: labels (Credit Limit … Due Date) then their values, dates in print order:
  // statement date, bill-period start, due date, bill-period end.
  const head = text.slice(text.search(/Credit\s+Limit/i), text.search(/Jio\s+Mobile\s+Number/i));
  const dates = [...head.matchAll(DATE_TOKEN)]
    .map((m) => iso(m[1]))
    .filter((d): d is string => !!d);
  const periodFrom = iso(plan?.[2]) ?? dates[1] ?? null;
  const periodTo = iso(plan?.[3]) ?? dates[3] ?? null;
  const statementDate = dates[0] ?? null;
  const due =
    iso(/Due\s+Date\s*:?\s*(\d{1,2}-[A-Za-z]{3}-\d{2,4})/i.exec(text)?.[1]) ??
    dates.find((d) => d !== statementDate && d !== periodFrom && d !== periodTo) ??
    null;
  // Charges block printed as values after "Total Payable": iv, v, then Connectivity (total,
  // plan, other, adjustments), Platform (total, plan, other, adjustments), other credits, taxes.
  const at = lines.findIndex((l) => /^vi\.?\s+Total\s+Payable/i.test(l));
  const vals: number[] = [];
  for (let i = at + 1; at >= 0 && i < lines.length && MONEY_LINE.test(lines[i]); i++)
    vals.push(parseAmountCell(lines[i]) as number);
  const block = vals.length === 12;
  const d = dataUsage(text);
  return {
    provider: 'Jio',
    service: 'postpaid',
    planName: plan ? plan[1].trim() : null,
    baseRentalInr: block ? r2(vals[3] + vals[7]) : null,
    addOns: addOns(text),
    usageChargesInr: usageCharges(text) ?? (block ? r2(vals[4] + vals[8]) : null),
    taxesInr: block ? vals[11] : null,
    totalPayableInr: total ? parseAmountCell(total[1]) : null,
    dueDate: due,
    periodFrom,
    periodTo,
    dataUsedGb: d.used,
    planDataGb: d.plan,
    includes: [],
    ottAppCount: null,
  };
}

/** JioFiber / AirFiber bill, or null. */
export function parseJioFiberBill(text: string): TelecomBillSummary | null {
  if (!/JioFiber|AirFiber/i.test(text)) return null;
  const plan =
    /(?:JioFiber|AirFiber)\s+Bill\s+Summary\s*\n\s*([^\n]+)/i.exec(text)?.[1]?.trim() ?? null;
  const planName = plan ? plan.replace(/\s+\d+\s*M$/i, '').trim() : null;
  const ott = /(\d+)\s*(?:PAID\s+)?OTT/i.exec(plan ?? text);
  const ottAppCount = ott ? Number(ott[1]) : null;
  const listed = /OTT\s+apps?\s*:\s*([A-Za-z][^\n]{3,200})/i.exec(text)?.[1];
  const total = /Total\s+Payable\s*:?\s*(\d[\d,]*\.\d{2})/i.exec(text);
  const period =
    /Monthly\s+Plan\s+Charges\s+\S+\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(
      text,
    );
  const rental = [
    ...text.matchAll(/Monthly\s+Plan\s+Charges\s+\S+\s+\S+\s+\S+\s+\d+\s+(\d[\d,]*\.\d{2})/gi),
  ]
    .map((m) => parseAmountCell(m[1]) as number)
    .reduce((s, v) => s + v, 0);
  const tax = /^\d+\s+Tax\s+\S+\s+\S+\s+\S+\s+(\d[\d,]*\.\d{2})$/im.exec(text);
  const d = dataUsage(text);
  return {
    provider: 'Jio',
    service: 'fiber',
    planName,
    baseRentalInr: rental ? r2(rental) : null,
    addOns: addOns(text),
    usageChargesInr: usageCharges(text),
    taxesInr: tax ? parseAmountCell(tax[1]) : null,
    totalPayableInr: total ? parseAmountCell(total[1]) : null,
    dueDate: iso(/Pay\s+By\s*:?\s*(\d{1,2}-[A-Za-z]{3}-\d{2,4})/i.exec(text)?.[1]),
    periodFrom:
      iso(period?.[1]) ??
      iso(/Billing\s+Cycle\s+Date\s*:?\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(text)?.[1]),
    periodTo: iso(period?.[2]),
    dataUsedGb: d.used,
    planDataGb: d.plan,
    includes: ottAppCount
      ? [
          listed
            ? `${ottAppCount} paid OTT apps: ${listed.trim()}`
            : `${ottAppCount} paid OTT apps (list not printed)`,
        ]
      : [],
    ottAppCount,
  };
}

/** Either telecom bill. */
export function parseTelecomBill(text: string): TelecomBillSummary | null {
  return parseJioFiberBill(text) ?? parseJioPostpaidBill(text);
}
