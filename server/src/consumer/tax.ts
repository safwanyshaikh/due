import type { Settings } from '../settings.js';

export const NOT_GST_REGISTERED = 'Not registered under GST';

export interface TaxDisplay {
  gstRegistered: boolean;
  gstin: string | null;
  /** Wording shown next to prices on the Plans screen. */
  note: string;
  pricesIncludeTax: boolean;
  /** Lines for invoices and receipts. */
  invoiceLines: string[];
}

/**
 * One source of truth for tax wording. Registered (with a GSTIN): prices show "incl. 18% GST" (or the admin's own
 * wording) and invoices carry the GSTIN. Not registered: no GST is charged or shown and invoices say so.
 */
export function taxDisplay(s: Pick<Settings, 'billing.tax_note' | 'billing.prices_include_tax' | 'billing.gst_registered' | 'billing.gstin'>): TaxDisplay {
  if (s['billing.gst_registered'] && s['billing.gstin']) {
    const note = s['billing.tax_note'] ?? 'Prices include 18% GST.';
    return { gstRegistered: true, gstin: s['billing.gstin'], note, pricesIncludeTax: s['billing.prices_include_tax'], invoiceLines: [`GSTIN: ${s['billing.gstin']}`, note] };
  }
  return {
    gstRegistered: false,
    gstin: null,
    note: 'No GST is charged.',
    pricesIncludeTax: false,
    invoiceLines: [NOT_GST_REGISTERED],
  };
}
