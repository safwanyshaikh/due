import { useEffect, useState } from 'react';
import { AccountApiError } from '../../lib/account/client';
import type { BillingPeriod, CheckoutResponse, PublicPlansResponse } from '../../lib/account/types';
import { FEATURES, PLANS, priceDisclosure, type PlanId } from '../../lib/plans';
import { formatDate } from '../../lib/dates';
import { formatINR } from '../../lib/money';
import { useApp } from '../store';
import { useAccount } from '../account/AccountContext';
import { describeApiError } from '../account/useIntake';
import { useToast } from '../components/Toast';
import { Badge, ConfirmButton, Notice, Panel } from '../components/ui';
import { modeLabel, usePublicStatus } from '../lib/platform';

export const PAYMENTS_UNAVAILABLE_COPY =
  'Payments aren’t available yet. Due stays free to use and nothing will be charged.';

type PlansState =
  | { kind: 'loading' }
  | { kind: 'live'; plans: PublicPlansResponse }
  | { kind: 'indicative'; reason: string };

interface ShownPlan {
  id: PlanId;
  name: string;
  monthlyInr: number | null;
  yearlyInr: number | null;
  features: string[];
  checkout: { monthly: boolean; yearly: boolean };
}

/** Plain-language names for the server's feature keys; unknown keys are humanised, never shown raw. */
const SERVER_FEATURE_LABELS: Record<string, string> = {
  manual_obligations: 'Add due items yourself',
  upcoming_view: 'Next 7 and 30 days at a glance',
  basic_reminders: 'In-app reminders',
  csv_export: 'CSV export',
  local_data: 'Works on this device without an account',
  backup: 'Backup to your account',
  multi_device: 'Use on more than one device',
  reminder_email: 'Email reminders',
  email_import: 'Receipt and email import',
  statement_import: 'Bank and card statement import',
  calendar_sync: 'Calendar sync',
  advanced_recurrence: 'Advanced schedules (weekday, trial to paid, every few months)',
  reconciliation_history: 'Confidence and correction history',
  multi_channel: 'Reminders by email and push',
  cancellation_guidance: 'Step-by-step cancellation guidance',
  verified_evidence: 'Proof of what you did and when',
  household_sharing: 'Share with your household',
};

export function featureLabel(key: string): string {
  if (SERVER_FEATURE_LABELS[key]) return SERVER_FEATURE_LABELS[key];
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * What Plus includes at launch, each tied to the integration it needs. A feature whose integration is not
 * live is shown as "not included yet" so it is never sold before it works.
 */
export const PLUS_FEATURES: { key: string; label: string; needs?: 'gmail' | 'inbound' | 'smtp' }[] =
  [
    { key: 'gmail', label: 'Gmail scanning (read-only)', needs: 'gmail' },
    { key: 'forwarding', label: 'Email forwarding to your private Due address', needs: 'inbound' },
    { key: 'documents', label: 'Unlimited document uploads (Free: 5 a month)' },
    { key: 'reminders', label: 'Advanced reminders, including email', needs: 'smtp' },
    { key: 'offers', label: 'Offer intelligence matches for your plans' },
    { key: 'sync', label: 'Cross-device sync and backup' },
  ];

function fromApi(p: PublicPlansResponse): ShownPlan[] {
  // The server already lists only active plans; never show an inactive one even if sent. Household is
  // hidden until sharing works end to end.
  return p.plans
    .filter((x) => x.active !== false && x.id !== 'household')
    .map((x) => ({
      id: x.id,
      name: x.name,
      monthlyInr: x.priceInrMonthly,
      yearlyInr: x.priceInrYearly,
      features: x.features.map(featureLabel),
      checkout: x.checkoutAvailable,
    }));
}

/** Fallback only when the API is unreachable: product constants, labelled indicative. */
function fromConstants(): ShownPlan[] {
  return (Object.keys(PLANS) as PlanId[])
    .filter((id) => PLANS[id].onSale && id !== 'household')
    .map((id) => {
      const p = PLANS[id];
      const price = (c: 'monthly' | 'yearly') => {
        const x = p.prices.find((q) => q.cadence === c);
        return x ? x.amountPaise / 100 : null;
      };
      return {
        id,
        name: p.name,
        monthlyInr: price('monthly'),
        yearlyInr: price('yearly'),
        features: Object.values(FEATURES)
          .filter((f) => f.plans.includes(id))
          .map((f) => f.label),
        checkout: { monthly: false, yearly: false },
      };
    });
}

export function PlansScreen() {
  const { client, status, entitlements, setEntitlements } = useAccount();
  const { today } = useApp();
  const toast = useToast();
  const st = usePublicStatus();
  const [state, setState] = useState<PlansState>({ kind: 'loading' });
  const [choice, setChoice] = useState<{ plan: PlanId; cadence: BillingPeriod } | null>(null);
  const [checkout, setCheckout] = useState<CheckoutResponse | null>(null);
  const [checkoutErr, setCheckoutErr] = useState<string | null>(null);

  useEffect(() => {
    client
      .getPublicPlans()
      .then((plans) => setState({ kind: 'live', plans }))
      .catch((e) => setState({ kind: 'indicative', reason: describeApiError(e) }));
  }, [client]);

  const plans =
    state.kind === 'live'
      ? fromApi(state.plans)
      : state.kind === 'indicative'
        ? fromConstants()
        : [];
  const live = state.kind === 'live' ? state.plans : null;
  const taxNote = (live as (PublicPlansResponse & { tax?: { note: string | null } }) | null)?.tax
    ?.note;
  const featureState = (needs?: 'gmail' | 'inbound' | 'smtp') => {
    if (!needs) return null;
    const m = st.state === 'ok' ? st.value.integrations[needs] : 'unknown';
    return m === 'live' ? null : `Not included yet: ${modeLabel(m).toLowerCase()}`;
  };
  const paymentsOn = !!live?.paymentsAvailable;
  const current = entitlements?.plan ?? 'free';
  const chosen = choice ? plans.find((p) => p.id === choice.plan) : null;
  const chosenPrice =
    chosen && choice ? (choice.cadence === 'monthly' ? chosen.monthlyInr : chosen.yearlyInr) : null;
  const renewal = choice ? priceDisclosure(choice.plan, choice.cadence, today) : null;

  const buy = async () => {
    if (!choice || choice.plan === 'free') return;
    setCheckoutErr(null);
    try {
      setCheckout(await client.checkout(choice.plan, choice.cadence));
    } catch (e) {
      if (e instanceof AccountApiError && (e.code === 'payments_unavailable' || e.status === 503))
        setCheckoutErr(PAYMENTS_UNAVAILABLE_COPY);
      else setCheckoutErr(describeApiError(e));
    }
  };

  return (
    <div className="page2">
      <header className="page-head">
        <h1>Plans</h1>
        <p className="muted">
          The core stays free: manual items, next 7 and 30 days, basic reminders, CSV export and
          local data. No surprise annual renewals.
        </p>
      </header>

      {state.kind === 'loading' && <p className="muted">Loading plans…</p>}
      {state.kind === 'indicative' && (
        <Notice tone="warn" title="Indicative prices">
          {state.reason} These are Due’s planned prices, shown for information only. Buying needs
          the server.
        </Notice>
      )}
      {live && !paymentsOn && <Notice tone="warn">{PAYMENTS_UNAVAILABLE_COPY}</Notice>}
      <p className="muted small" data-testid="tax-note">
        All prices in Indian rupees (INR).{' '}
        {taxNote ? taxNote : 'Any applicable tax is shown before you pay.'}
      </p>
      {status === 'signed_in' && current !== 'free' && entitlements?.periodEnd && (
        <Notice tone="info" title={`Your plan: ${current === 'plus' ? 'Plus' : current}`}>
          {entitlements.status === 'cancelled'
            ? `Cancelled. Access continues until ${formatDate(entitlements.periodEnd.slice(0, 10))}; no further charges.`
            : `Renews on ${formatDate(entitlements.periodEnd.slice(0, 10))}${entitlements.billingPeriod ? ` (${entitlements.billingPeriod})` : ''}. Manage or cancel below.`}
        </Notice>
      )}

      <ul className="plans">
        {plans.map((p) => (
          <li key={p.id} className="panel2 plan">
            <div className="section-head">
              <h2>{p.name}</h2>
              {current === p.id && <Badge tone="calm">Your plan</Badge>}
              {state.kind === 'indicative' && p.id !== 'free' && (
                <Badge tone="warm">Indicative</Badge>
              )}
            </div>
            <p className="amt plan-price">
              {p.monthlyInr === null && p.yearlyInr === null
                ? 'Free'
                : [
                    p.monthlyInr !== null ? `${formatINR(p.monthlyInr * 100)}/month` : null,
                    p.yearlyInr !== null ? `${formatINR(p.yearlyInr * 100)}/year` : null,
                  ]
                    .filter(Boolean)
                    .join(' or ')}
            </p>
            {p.id === 'plus' ? (
              <ul className="feat-list" data-testid="plus-features">
                {PLUS_FEATURES.map((f) => {
                  const blocked = featureState(f.needs);
                  return (
                    <li key={f.key}>
                      {f.label} {blocked && <Badge tone="warm">{blocked}</Badge>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <ul className="feat-list">
                {p.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            )}
            {p.id !== 'free' && (
              <div className="btn-row">
                {p.monthlyInr !== null && (
                  <button
                    type="button"
                    className="btn btn-secondary press"
                    aria-pressed={choice?.plan === p.id && choice.cadence === 'monthly'}
                    onClick={() => {
                      setChoice({ plan: p.id, cadence: 'monthly' });
                      setCheckout(null);
                      setCheckoutErr(null);
                    }}
                  >
                    Choose monthly
                  </button>
                )}
                {p.yearlyInr !== null && (
                  <button
                    type="button"
                    className="btn btn-secondary press"
                    aria-pressed={choice?.plan === p.id && choice.cadence === 'yearly'}
                    onClick={() => {
                      setChoice({ plan: p.id, cadence: 'yearly' });
                      setCheckout(null);
                      setCheckoutErr(null);
                    }}
                  >
                    Choose yearly
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {choice && chosen && (
        <Panel title="Before you buy" id="pl-disc">
          <dl className="kv">
            <div>
              <dt>Price</dt>
              <dd className="amt">
                {chosenPrice !== null
                  ? `${formatINR(chosenPrice * 100)} per ${choice.cadence === 'monthly' ? 'month' : 'year'}`
                  : 'Not available for this cadence'}
                {state.kind === 'indicative' ? ' (indicative)' : ''}
              </dd>
            </div>
            <div>
              <dt>Billing</dt>
              <dd>
                {choice.cadence === 'monthly' ? 'Every month' : 'Once a year'}, renews automatically
              </dd>
            </div>
            <div>
              <dt>First renewal</dt>
              <dd>
                {renewal ? `${formatDate(renewal.renewalDate)} unless you cancel before then` : '—'}
              </dd>
            </div>
            <div>
              <dt>Paid through</dt>
              <dd>
                {live?.purchaseChannel === 'razorpay'
                  ? 'Razorpay (cards, UPI, net banking)'
                  : 'Not available yet'}
              </dd>
            </div>
            <div>
              <dt>Cancelling</dt>
              <dd>{live?.cancellationPath ?? 'Shown when payments are available.'}</dd>
            </div>
            {live && (
              <>
                <div>
                  <dt>Renewal terms</dt>
                  <dd>{live.terms.renewal}</dd>
                </div>
                <div>
                  <dt>Cancellation terms</dt>
                  <dd>{live.terms.cancellation}</dd>
                </div>
                <div>
                  <dt>Refunds</dt>
                  <dd>{live.terms.refund}</dd>
                </div>
              </>
            )}
          </dl>
          {live?.terms.legalReviewStatus === 'pending' && (
            <p className="muted small">These terms are pending legal review.</p>
          )}
          {status === 'signed_in' && current !== 'free' && (
            <Notice tone="warn">
              {entitlements?.status === 'cancelled'
                ? 'Your current plan stays active until the end of its paid period. You can choose a new plan after it ends.'
                : 'You already have a plan. Cancel it first (it stays active until the period ends) before choosing another.'}
            </Notice>
          )}
          {status !== 'signed_in' ? (
            <a className="btn btn-primary press" href="#/account">
              Sign in to continue
            </a>
          ) : (
            <button
              type="button"
              className="btn btn-primary press"
              disabled={!paymentsOn || !chosen.checkout[choice.cadence] || current !== 'free'}
              onClick={() => void buy()}
            >
              Continue to secure payment
            </button>
          )}
          {(!paymentsOn || !chosen.checkout[choice.cadence]) && (
            <p className="muted small">{PAYMENTS_UNAVAILABLE_COPY}</p>
          )}
          {checkoutErr && <Notice tone="warn">{checkoutErr}</Notice>}
          {checkout && (
            <Notice tone="ok" title="Payment ready">
              {formatINR(checkout.amountInr * 100)} · {checkout.renewal}.{' '}
              {checkout.shortUrl ? (
                <a href={checkout.shortUrl} rel="noopener noreferrer">
                  Open Razorpay to complete payment
                </a>
              ) : (
                'The payment link wasn’t provided. Try again later.'
              )}{' '}
              After paying, come back and press Restore purchase.
            </Notice>
          )}
        </Panel>
      )}

      {status === 'signed_in' && (
        <Panel title="Manage, cancel or restore" id="pl-restore">
          {live?.cancellationPath && <p className="muted small">{live.cancellationPath}</p>}
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-secondary press"
              onClick={() =>
                client
                  .restorePurchase()
                  .then((r) => {
                    setEntitlements(r.entitlements);
                    toast.show({
                      message: `Plan checked: ${r.entitlements.plan}`,
                      tone: 'success',
                    });
                  })
                  .catch((e) =>
                    toast.show({
                      message:
                        e instanceof AccountApiError && e.code === 'payments_unavailable'
                          ? PAYMENTS_UNAVAILABLE_COPY
                          : describeApiError(e),
                      tone: 'error',
                    }),
                  )
              }
            >
              Restore purchase
            </button>
            {current !== 'free' &&
              entitlements?.status === 'active' &&
              entitlements.channel === 'razorpay' && (
                <ConfirmButton
                  label="Cancel subscription"
                  confirmLabel="Yes, cancel"
                  className="btn btn-quiet press"
                  message="You keep access until the end of the paid period. No further charges."
                  onConfirm={() =>
                    client
                      .cancelSubscription()
                      .then((r) => {
                        setEntitlements(r.entitlements);
                        toast.show({ message: 'Subscription cancelled', tone: 'success' });
                      })
                      .catch((e) => toast.show({ message: describeApiError(e), tone: 'error' }))
                  }
                />
              )}
          </div>
          {current !== 'free' && entitlements?.channel === 'manual' && (
            <p className="muted small">
              Your plan was set up by Due support, not bought through the app, so there is nothing
              to cancel here. It ends on its own
              {entitlements.periodEnd
                ? ` on ${formatDate(entitlements.periodEnd.slice(0, 10))}`
                : ''}
              .
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
