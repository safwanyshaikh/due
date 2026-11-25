import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { formatIST } from '../lib/format';
import { useAction, useApi } from '../lib/useApi';
import { Badge, Field, LiveStatus, Loadable, PageHeader } from '../components/ui';

export interface PlanRow {
  id: 'free' | 'plus' | 'household';
  name: string;
  priceInrMonthly: number | null;
  priceInrYearly: number | null;
  active: boolean;
  features: string[];
  providerPlanIds: { monthly?: string; yearly?: string; cashfree?: { monthly?: string; yearly?: string } };
  sortOrder: number;
  updatedAt: string;
}

interface PlansResponse {
  items: PlanRow[];
  total: number;
  paymentsConfigured: boolean;
  billingProvider?: 'razorpay' | 'cashfree';
  providers?: { razorpay: { configured: boolean }; cashfree: { configured: boolean; env: 'sandbox' | 'production' | null } };
}

const CASHFREE_PLAN_ID = /^[A-Za-z0-9_-]{3,40}$/;
const RAZORPAY_PLAN_ID = /^plan_[A-Za-z0-9]{6,40}$/;

/** Price text → number (rupees, 2 decimals) or null when blank. Returns undefined when invalid. */
export function parsePrice(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return undefined;
  return Number(t);
}

/** Builds the PATCH body for /admin/plans/:id from the form, or returns an error message. */
export function planPatch(
  plan: PlanRow,
  form: { monthly: string; yearly: string; active: boolean; rzpMonthly: string; rzpYearly: string; cfMonthly?: string; cfYearly?: string },
): { body: Record<string, unknown> } | { error: string } {
  const monthly = parsePrice(form.monthly);
  const yearly = parsePrice(form.yearly);
  if (monthly === undefined || yearly === undefined) return { error: 'Prices must be amounts in rupees, like 149 or 1299.00.' };
  const ids: Record<string, string | null> = {};
  for (const [k, v] of [
    ['monthly', form.rzpMonthly.trim()],
    ['yearly', form.rzpYearly.trim()],
  ] as const) {
    if (v && !RAZORPAY_PLAN_ID.test(v)) return { error: `The ${k} Razorpay plan id should look like plan_XXXXXXXX.` };
    ids[k] = v || null;
  }
  const providerPlanIds: Record<string, unknown> = { ...ids };
  if (form.cfMonthly !== undefined || form.cfYearly !== undefined) {
    const cf: Record<string, string | null> = {};
    for (const [k, v] of [
      ['monthly', (form.cfMonthly ?? '').trim()],
      ['yearly', (form.cfYearly ?? '').trim()],
    ] as const) {
      if (v && !CASHFREE_PLAN_ID.test(v)) return { error: `The ${k} Cashfree plan id may use letters, digits, - and _ (3 to 40 characters).` };
      cf[k] = v || null;
    }
    providerPlanIds.cashfree = cf;
  }
  const body: Record<string, unknown> = { active: form.active, providerPlanIds };
  if (plan.id !== 'free') {
    body.priceInrMonthly = monthly;
    body.priceInrYearly = yearly;
  }
  return { body };
}

function PlanCard({ plan, canEdit, onSaved }: { plan: PlanRow; canEdit: boolean; onSaved: () => void }) {
  const [monthly, setMonthly] = useState(plan.priceInrMonthly === null ? '' : String(plan.priceInrMonthly));
  const [yearly, setYearly] = useState(plan.priceInrYearly === null ? '' : String(plan.priceInrYearly));
  const [active, setActive] = useState(plan.active);
  const [rzpMonthly, setRzpMonthly] = useState(plan.providerPlanIds?.monthly ?? '');
  const [rzpYearly, setRzpYearly] = useState(plan.providerPlanIds?.yearly ?? '');
  const [cfMonthly, setCfMonthly] = useState(plan.providerPlanIds?.cashfree?.monthly ?? '');
  const [cfYearly, setCfYearly] = useState(plan.providerPlanIds?.cashfree?.yearly ?? '');
  const action = useAction();
  const paid = plan.id !== 'free';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = planPatch(plan, {
      monthly,
      yearly,
      active,
      rzpMonthly,
      rzpYearly,
      // Only send Cashfree ids when edited, so saving a Razorpay-era plan does not touch them.
      ...(cfMonthly !== (plan.providerPlanIds?.cashfree?.monthly ?? '') || cfYearly !== (plan.providerPlanIds?.cashfree?.yearly ?? '') ? { cfMonthly, cfYearly } : {}),
    });
    if ('error' in p) {
      action.setStatus({ kind: 'error', text: p.error });
      return;
    }
    const r = await action.run(() => api.patch(`/admin/plans/${plan.id}`, p.body), `${plan.name} saved.`);
    if (r !== undefined) onSaved();
  }

  return (
    <form className="card" onSubmit={submit} aria-label={`${plan.name} plan`}>
      <h2>
        {plan.name} <Badge tone={plan.active ? 'ok' : 'neutral'}>{plan.active ? 'On sale' : 'Not sold'}</Badge>
      </h2>
      {plan.id === 'household' ? (
        <p className="muted small">Keep this off until household sharing works end to end. While off, it is hidden from the app and checkout refuses it.</p>
      ) : null}
      <fieldset disabled={!canEdit} className="plain">
        <div className="form-grid">
          {paid ? (
            <>
              <Field label="Monthly price (₹)" hint="Leave blank to not offer monthly billing.">
                {(id, h) => <input id={id} inputMode="decimal" aria-describedby={h} value={monthly} onChange={(e) => setMonthly(e.target.value)} />}
              </Field>
              <Field label="Yearly price (₹)" hint="Leave blank to not offer yearly billing.">
                {(id, h) => <input id={id} inputMode="decimal" aria-describedby={h} value={yearly} onChange={(e) => setYearly(e.target.value)} />}
              </Field>
              <Field label="Razorpay plan id (monthly)" hint="From Razorpay Dashboard → Subscriptions → Plans.">
                {(id, h) => <input id={id} aria-describedby={h} value={rzpMonthly} placeholder="plan_…" onChange={(e) => setRzpMonthly(e.target.value)} />}
              </Field>
              <Field label="Razorpay plan id (yearly)">
                {(id) => <input id={id} value={rzpYearly} placeholder="plan_…" onChange={(e) => setRzpYearly(e.target.value)} />}
              </Field>
              <Field label="Cashfree plan id (monthly)" hint="The plan_id you created in Cashfree Dashboard → Subscriptions → Plans.">
                {(id, h) => <input id={id} aria-describedby={h} value={cfMonthly} placeholder="due_plus_monthly" onChange={(e) => setCfMonthly(e.target.value)} />}
              </Field>
              <Field label="Cashfree plan id (yearly)">
                {(id) => <input id={id} value={cfYearly} placeholder="due_plus_yearly" onChange={(e) => setCfYearly(e.target.value)} />}
              </Field>
            </>
          ) : null}
          <div className="span-2">
            <label className="check">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Offer this plan (shown in the app and
              available at checkout)
            </label>
          </div>
        </div>
      </fieldset>
      <p className="muted small">
        Plan <code>{plan.id}</code>
        {plan.updatedAt ? ` · last updated ${formatIST(plan.updatedAt)}` : ''}
      </p>
      <LiveStatus status={action.status} />
      {canEdit ? (
        <button className="btn btn-primary" type="submit" disabled={action.busy}>
          Save
        </button>
      ) : null}
    </form>
  );
}

export function PlansPage() {
  const res = useApi<PlansResponse>('/admin/plans');
  const canEdit = useCan('admin');
  const items = res.data?.items ?? [];
  return (
    <>
      <PageHeader title="Plans">
        {canEdit ? 'Prices, availability and Razorpay plan ids. The app reads these; nothing is hard-coded.' : 'Read-only. Admins can change plans.'}
      </PageHeader>
      {res.data?.billingProvider ? (
        <p className="msg" role="note" data-testid="active-provider">
          Active payment provider: <strong>{res.data.billingProvider === 'cashfree' ? 'Cashfree' : 'Razorpay'}</strong>
          {res.data.billingProvider === 'cashfree' && res.data.providers?.cashfree.env ? ` (${res.data.providers.cashfree.env})` : ''}. Set on the server with{' '}
          <code>BILLING_PROVIDER</code>; each plan keeps one id per provider below.
        </p>
      ) : null}
      {res.data && !res.data.paymentsConfigured ? (
        <p className="msg msg-error" role="note">
          {res.data.billingProvider === 'cashfree' ? 'Cashfree' : 'Razorpay'} keys are not configured on the server, so checkout is unavailable whatever is set here.
        </p>
      ) : null}
      <Loadable loading={res.loading} error={res.error} empty={items.length === 0}>
        {items.map((p) => (
          <PlanCard key={`${p.id}:${p.updatedAt}`} plan={p} canEdit={canEdit} onSaved={res.reload} />
        ))}
      </Loadable>
    </>
  );
}
