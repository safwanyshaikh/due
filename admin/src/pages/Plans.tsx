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
  providerPlanIds: { monthly?: string; yearly?: string };
  sortOrder: number;
  updatedAt: string;
}

interface PlansResponse {
  items: PlanRow[];
  total: number;
  paymentsConfigured: boolean;
}

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
  form: { monthly: string; yearly: string; active: boolean; rzpMonthly: string; rzpYearly: string },
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
  const body: Record<string, unknown> = { active: form.active, providerPlanIds: ids };
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
  const action = useAction();
  const paid = plan.id !== 'free';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = planPatch(plan, { monthly, yearly, active, rzpMonthly, rzpYearly });
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
      {res.data && !res.data.paymentsConfigured ? (
        <p className="msg msg-error" role="note">
          Razorpay keys are not configured on the server, so checkout is unavailable whatever is set here.
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
