import { describe, expect, it } from 'vitest';
import { emptyData } from '../data';
import {
  addImportItems,
  approveImportItem,
  deleteImportRaw,
  describeImportItem,
  editImportItem,
  ignoreImportItem,
  importItemFromReceipt,
  importItemFromText,
  importItemsFromCsv,
  isPaymentConfirmation,
  pendingImports,
  purgeExpiredRaw,
} from '../imports';
import { needsAttention } from '../home';
import { isPaymentConfirmationText } from '../intake';
import { createObligation, markPaid, markReviewed } from '../mutations';
import { activeObligations, effectiveNext, liveHistory } from '../obligations';
import { rules } from '../recurrence';
import type { AppData } from '../types';
import { ctx, NOW, TODAY } from './helpers';

// Synthetic receipts written for these tests only.
const NETFLIX_RECEIPT = `From: Netflix <info@account.netflix.com>
Your membership has been renewed.
Amount charged: ₹649.00
Next billing date: 07 Nov 2026
Card ending 1111. Manage at https://www.netflix.com/account`;

const NEW_SUB = `Your Spotify Premium subscription
Amount: Rs 119
Next billing date: 12-Nov-2026
Billed monthly`;

function queued(
  data: AppData,
  text: string,
  kind: 'receipt_text' | 'forwarded_email' | 'shared_sms' | 'document' = 'receipt_text',
) {
  const b = importItemFromText(data, { kind, text, receivedAt: NOW });
  const r = addImportItems(data, [b], ctx());
  return { data: r.data, id: b.item.id, item: b.item, userEvent: b.userEvent, skipped: r.skipped };
}

function withNetflix(): { data: AppData; obId: string } {
  const r = createObligation(
    emptyData(),
    {
      type: 'subscription',
      provider: 'Netflix',
      amountPaise: 49900,
      rule: rules.monthly('2026-11-05'),
    },
    ctx(),
  );
  return { data: r.data, obId: r.data.commitments[0].id };
}

describe('extraction into the queue', () => {
  it('receipt text → extracted fields with per-field confidence, match and redacted raw', () => {
    const { data, obId } = withNetflix();
    const { item, userEvent } = importItemFromReceipt(
      data,
      NETFLIX_RECEIPT + '\nCard 4111 1111 1111 1111',
      NOW,
    );
    expect(item.extracted).toMatchObject({
      merchant: 'Netflix',
      canonicalProvider: 'netflix',
      amountPaise: 64900,
      date: '2026-11-07',
      dateKind: 'renewal',
      link: 'https://www.netflix.com/account',
    });
    expect(item.extracted.confidencePerField.amount).toBeGreaterThan(0.8);
    expect(item.matchedObligationId).toBe(obId);
    expect(item.matchReason).toMatch(/Same provider \(Netflix\)/);
    expect(item.raw.text).not.toContain('4111 1111');
    expect(item.redactions).toEqual([{ kind: 'card_number', count: 1 }]);
    expect(item.status).toBe('pending');
    expect(item.userEventId).toBe(userEvent.id);
    expect(userEvent.intakeType).toBe('document');
  });
  it('adding is audited as an import, and a repeat message fingerprint is skipped', () => {
    const first = queued(emptyData(), NEW_SUB, 'forwarded_email');
    expect(first.data.audit.at(-1)).toMatchObject({ action: 'import_received', actor: 'import' });
    expect(pendingImports(first.data)).toHaveLength(1);
    const again = importItemFromText(first.data, {
      kind: 'forwarded_email',
      text: NEW_SUB,
      receivedAt: NOW,
    });
    const r = addImportItems(first.data, [again], ctx());
    expect(r.skipped).toHaveLength(1);
    expect(pendingImports(r.data)).toHaveLength(1);
  });
  it('CSV rows reuse csv.ts guards; blocked columns are rejected', () => {
    const ok = importItemsFromCsv(
      emptyData(),
      'type,provider,nickname,amount,frequency,next_due\nsubscription,Prime Video,Prime,299,monthly,2026-11-20\nbill,,x,1,monthly,2026-11-20\n',
      NOW,
    );
    expect(ok.items).toHaveLength(1);
    expect(ok.items[0].extracted).toMatchObject({
      merchant: 'Prime Video',
      canonicalProvider: 'amazon_prime',
      amountPaise: 29900,
      cadence: 'monthly',
    });
    expect(ok.items[0].raw).toMatchObject({ kind: 'csv_row', ref: 'csv:line 2' });
    expect(ok.errors[0]).toMatch(/Line 3/);
    const bad = importItemsFromCsv(emptyData(), 'provider,card_number\nX,4111111111111111\n', NOW);
    expect(bad.items).toEqual([]);
    expect(bad.errors[0]).toMatch(/never accept/);
  });
});

describe('approve / edit / ignore / undo', () => {
  it('approve on a match updates amount (imported provenance), moves only the near occurrence, keeps raw provenance', () => {
    const base = withNetflix();
    const q = queued(base.data, NETFLIX_RECEIPT);
    const r = approveImportItem(q.data, q.id, ctx());
    const ob = activeObligations(r.data)[0];
    expect(ob.amount).toMatchObject({
      value: 64900,
      confidence: 'imported',
      source: { kind: 'email_forward', label: 'Pasted receipt', rawRef: q.id, importedAt: NOW },
    });
    expect(ob.rule).toEqual(rules.monthly('2026-11-05'));
    expect(effectiveNext(ob, TODAY)).toMatchObject({
      occurrenceDate: '2026-11-05',
      date: '2026-11-07',
      dateConfidence: 'imported',
    });
    const item = r.data.importQueue[0];
    expect(item).toMatchObject({ status: 'approved', resultObligationId: base.obId });
    expect(item.raw.text).toContain('Netflix');
    expect(r.data.userEvents[0].reviewStatus).toBe('confirmed');
    expect(r.event.action).toBe('import_approved');
    // undo restores the obligation and the pending item
    const back = r.undo();
    expect(activeObligations(back)[0].amount.value).toBe(49900);
    expect(pendingImports(back)).toHaveLength(1);
    expect(back.userEvents[0].reviewStatus).toBe('needs_review');
  });
  it('approve without a match creates an obligation from the extraction', () => {
    const q = queued(emptyData(), NEW_SUB, 'forwarded_email');
    const r = approveImportItem(q.data, q.id, ctx());
    const ob = activeObligations(r.data)[0];
    expect(ob).toMatchObject({
      provider: 'Spotify',
      type: 'subscription',
      canonicalProvider: 'spotify',
    });
    expect(ob.rule).toEqual(rules.monthly('2026-11-12'));
    expect(ob.amount).toMatchObject({
      value: 11900,
      confidence: 'imported',
      source: { kind: 'email_forward', label: 'Forwarded email' },
    });
    expect(ob.date.confidence).toBe('imported');
    expect(activeObligations(r.undo())).toEqual([]);
  });
  it('unknown cadence never invents a schedule (irregular with the extracted date)', () => {
    const q = queued(
      emptyData(),
      'Biller: Sharma Tuition\nAmount payable ₹3,000\nDue date 20/11/2026',
    );
    const ob = activeObligations(approveImportItem(q.data, q.id, ctx()).data)[0];
    expect(ob.rule).toEqual(rules.irregular('2026-11-20'));
  });
  it('a trial email becomes a trial_to_paid rule', () => {
    const q = queued(
      emptyData(),
      'Your YouTube Premium free trial ends 12 Nov 2026. Then ₹149/month.',
    );
    const ob = activeObligations(approveImportItem(q.data, q.id, ctx()).data)[0];
    expect(ob.rule).toEqual(rules.trialToPaid('2026-11-12', 14900, rules.monthly('2026-11-12')));
    expect(ob.status).toBe('trial');
  });
  it('a past paid receipt on a match records paid evidence instead of moving dates', () => {
    const r0 = createObligation(
      emptyData(),
      {
        type: 'subscription',
        provider: 'Netflix',
        amountPaise: 49900,
        rule: rules.monthly('2026-10-05'),
      },
      ctx(),
    );
    const q = queued(r0.data, 'Netflix payment receipt\nAmount paid ₹499\nPaid on 06/10/2026');
    const ob = activeObligations(approveImportItem(q.data, q.id, ctx()).data)[0];
    expect(liveHistory(ob)).toMatchObject([
      {
        kind: 'paid',
        occurrenceDate: '2026-10-05',
        actor: 'import',
        evidenceRef: q.id,
        amountPaise: 49900,
      },
    ]);
    expect(ob.overrides).toEqual([]);
    expect(effectiveNext(ob, TODAY)?.date).toBe('2026-11-05');
  });
  it('a bill with a past due date on a match is never marked paid: it raises overdue_review', () => {
    const r0 = createObligation(
      emptyData(),
      {
        type: 'bill',
        provider: 'Airtel',
        amountPaise: 99900,
        rule: rules.monthly('2026-10-05'),
      },
      ctx(),
    );
    const q = queued(
      r0.data,
      'Airtel postpaid bill\nBill amount ₹999\nDue date 06/10/2026\nPlease pay before the due date.',
    );
    expect(q.data.importQueue[0].extracted.documentKind).toBe('bill');
    expect(isPaymentConfirmation(q.data.importQueue[0])).toBe(false);
    const ap = approveImportItem(q.data, q.id, ctx());
    const ob = activeObligations(ap.data)[0];
    expect(liveHistory(ob)).toEqual([]);
    expect(ob.overdueReview).toMatchObject({
      occurrenceDate: '2026-10-05',
      date: '2026-10-06',
      importItemId: q.id,
    });
    const att = needsAttention(ap.data, TODAY).filter((a) => a.kind === 'overdue_review');
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ obligationId: ob.id, severity: 'important' });
    // Marking that occurrence paid (or reviewing it) resolves the question.
    const paid = markPaid(ap.data, ob.id, ctx(), '2026-10-05');
    expect(needsAttention(paid.data, TODAY).some((a) => a.kind === 'overdue_review')).toBe(false);
    const reviewed = markReviewed(ap.data, ob.id, ctx(), '2026-10-05');
    expect(activeObligations(reviewed.data)[0].overdueReview).toBeNull();
    // Undo of the approval removes the flag with everything else.
    expect(activeObligations(ap.undo())[0].overdueReview).toBeUndefined();
  });
  it('a payment confirmation ("payment successful") on a match marks the past occurrence paid', () => {
    const r0 = createObligation(
      emptyData(),
      {
        type: 'bill',
        provider: 'Airtel',
        amountPaise: 99900,
        rule: rules.monthly('2026-10-05'),
      },
      ctx(),
    );
    const q = queued(
      r0.data,
      'Airtel: Payment successful. ₹999 received for your postpaid bill due 06/10/2026.',
    );
    expect(q.data.importQueue[0].extracted.documentKind).toBe('receipt');
    const ob = activeObligations(approveImportItem(q.data, q.id, ctx()).data)[0];
    expect(liveHistory(ob)).toMatchObject([{ kind: 'paid', occurrenceDate: '2026-10-05' }]);
    expect(ob.overdueReview).toBeUndefined();
  });
  it('a new item from a bill with a past due date is flagged for review, not assumed paid', () => {
    const q = queued(
      emptyData(),
      'Biller: Sharma Tuition\nAmount payable ₹3,000\nDue date 20/10/2026',
    );
    const ob = activeObligations(approveImportItem(q.data, q.id, ctx()).data)[0];
    expect(liveHistory(ob)).toEqual([]);
    expect(ob.overdueReview).toMatchObject({ date: '2026-10-20' });
  });
  it('recognises payment confirmations but not payment requests', () => {
    for (const t of [
      'Payment received, thank you',
      'Your payment of ₹499 was successful',
      'Transaction successful',
      'Paid on 06/10/2026',
      'Amount paid: ₹649',
      'Thank you for your payment',
    ])
      expect(isPaymentConfirmationText(t), t).toBe(true);
    for (const t of [
      'Amount to be paid on or before 06/10/2026',
      'Unpaid on 06/10/2026',
      'Amount payable ₹999',
      'Please pay by the due date',
      'Bill due 06/10/2026',
    ])
      expect(isPaymentConfirmationText(t), t).toBe(false);
  });
  it('edits become user-entered on approve and re-run matching', () => {
    const q = queued(
      emptyData(),
      'Biller: Sharma Tuition\nAmount payable ₹3,000\nDue date 20/11/2026',
    );
    const e = editImportItem(q.data, q.id, { amountPaise: 320000, cadence: 'monthly' }, ctx());
    expect(e.data.importQueue[0].status).toBe('edited');
    expect(describeImportItem(e.data.importQueue[0])).toBe('Sharma Tuition · ₹3,200 · 20 Nov 2026');
    const ob = activeObligations(approveImportItem(e.data, q.id, ctx()).data)[0];
    expect(ob.amount).toMatchObject({ value: 320000, confidence: 'user_entered' });
    expect(ob.date.confidence).toBe('imported');
    expect(ob.rule).toEqual(rules.monthly('2026-11-20'));
    expect(e.undo().importQueue[0].status).toBe('pending');
  });
  it('ignore marks the item and its user event; undo restores; approved items cannot be re-approved', () => {
    const q = queued(emptyData(), NEW_SUB);
    const ig = ignoreImportItem(q.data, q.id, ctx());
    expect(ig.data.importQueue[0].status).toBe('ignored');
    expect(ig.data.userEvents[0].reviewStatus).toBe('ignored');
    expect(pendingImports(ig.data)).toEqual([]);
    expect(pendingImports(ig.undo())).toHaveLength(1);
    expect(() => approveImportItem(ig.data, q.id, ctx())).toThrow();
  });
  it('delete-before-save removes raw content and marks the event deleted', () => {
    const q = queued(emptyData(), NEW_SUB);
    const d = deleteImportRaw(q.data, q.id, ctx());
    expect(d.data.importQueue[0].raw.text).toBeNull();
    expect(d.data.importQueue[0].status).toBe('ignored');
    expect(d.data.userEvents[0].reviewStatus).toBe('deleted');
    expect(activeObligations(d.data)).toEqual([]);
  });
  it('only http(s) links become provider help links on approve', () => {
    const q = queued(emptyData(), NEW_SUB);
    const bad = editImportItem(q.data, q.id, { link: 'javascript:alert(1)' }, ctx());
    const ob = activeObligations(approveImportItem(bad.data, q.id, ctx()).data)[0];
    expect(ob.subscription?.helpUrl).toBeUndefined();
    const good = editImportItem(q.data, q.id, { link: 'https://example.com/help' }, ctx());
    const ob2 = activeObligations(approveImportItem(good.data, q.id, ctx()).data)[0];
    expect(ob2.subscription?.helpUrl).toBe('https://example.com/help');
  });
  it('deleting or purging raw content also removes it from the audit log', () => {
    const hasRaw = (data: unknown) => JSON.stringify(data).includes('Next billing date');
    const q = queued(emptyData(), NEW_SUB);
    expect(hasRaw(q.data.audit)).toBe(true);
    const d = deleteImportRaw(q.data, q.id, ctx());
    const texts = d.data.audit.flatMap((e) =>
      [e.before.importQueue, e.after.importQueue].flatMap((r) =>
        Object.values(r ?? {}).map((i) => i?.raw.text ?? null),
      ),
    );
    expect(texts.every((t) => t === null)).toBe(true);
    // Undo restores the item for review but never brings the deleted text back.
    const u = d.undo();
    expect(u.importQueue[0].status).toBe('pending');
    expect(u.importQueue[0].raw.text).toBeNull();
    const p = purgeExpiredRaw(q.data, '2026-11-07T00:00:00.000Z');
    expect(
      p.audit.every((e) =>
        Object.values(e.after.importQueue ?? {}).every((i) => !i || i.raw.text === null),
      ),
    ).toBe(true);
  });
  it('raw text is purged after retention', () => {
    const q = queued(emptyData(), NEW_SUB);
    expect(purgeExpiredRaw(q.data, '2026-11-01T00:00:00.000Z')).toBe(q.data);
    const p = purgeExpiredRaw(q.data, '2026-11-07T00:00:00.000Z');
    expect(p.importQueue[0].raw.text).toBeNull();
    expect(p.importQueue[0].extracted.amountPaise).toBe(11900);
  });
});
