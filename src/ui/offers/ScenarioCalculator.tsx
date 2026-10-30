import { useState } from 'react';
import { useApp } from '../store';
import { Disclaimer, PENDING_TEXT, useCatalog } from './parts';
import { isVerificationPending } from '../../lib/offers/status';
import type { OfferRecord } from '../../lib/offers/types';
import {
  airtel699Prime,
  airtelMonthlyCashback,
  googleAiTrial,
  jioAiCloud,
  type ScenarioResult,
} from '../../lib/offers/calculator';
import { addOfferReminder } from '../../lib/offers/services';
import { PAYMENT_NOTE } from '../../lib/offers/copy';
import { parseRupees, formatINR } from '../../lib/money';
import { formatDate } from '../../lib/dates';

const KIND: Record<string, string> = {
  documented: 'documented',
  user_assumption: 'user assumption',
  estimated_value: 'estimated value',
  note: '',
};

function Result({
  r,
  onRemind,
  remindLabel,
}: {
  r: ScenarioResult;
  onRemind?: (d: string) => void;
  remindLabel?: string;
}) {
  return (
    <div className="calcout" aria-live="polite">
      {r.lines.map((l) => (
        <div className="line" key={l.label}>
          <span>
            {l.label}
            {KIND[l.kind] ? <span className="muted small"> · {KIND[l.kind]}</span> : null}
          </span>
          <span className="amt">{l.paise === null ? '' : formatINR(l.paise)}</span>
        </div>
      ))}
      <div className="line">
        <b>Estimated value (not guaranteed)</b>
        <b className="amt">{formatINR(r.estimatedValuePaise)}</b>
      </div>
      <p className="small">Confidence: {r.confidence}</p>
      {r.warnings.map((w) => (
        <p key={w} className="note small">
          {w}
        </p>
      ))}
      {r.unresolved.length > 0 && (
        <p className="muted small">Still unresolved: {r.unresolved.join('; ')}.</p>
      )}
      {r.reminderDate && onRemind && (
        <button className="btn quiet" onClick={() => onRemind(r.reminderDate!)}>
          {remindLabel ?? 'Set reminder'} · {formatDate(r.reminderDate)}
        </button>
      )}
    </div>
  );
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}
const pricePaise = (o?: OfferRecord) => (o?.price != null ? Math.round(o.price * 100) : null);

function SourceNote({ o }: { o?: OfferRecord }) {
  if (!o)
    return (
      <p className="muted small">
        Due’s monitoring service has no record for this right now, so no documented figure is used.
      </p>
    );
  return (
    <p className="muted small">
      Documented figures come from <a href={`#/offer/${o.offerId}`}>{o.name}</a>
      {isVerificationPending(o) ? ` (${PENDING_TEXT.toLowerCase()})` : ''}.
    </p>
  );
}

export function ScenarioCalculator() {
  const { update } = useApp();
  const { offers } = useCatalog();
  const find = (id: string) => offers.find((o) => o.offerId === id);
  const airtelPrime = find('airtel-699-prime');
  const jioTrial = find('jio-aicloud-nonjio-trial');
  const googlePlan = (p: 'plus' | 'pro') => find(p === 'pro' ? 'google-ai-pro' : 'google-ai-plus');
  const [msg, setMsg] = useState('');
  const remind = (label: string) => (d: string) => {
    update((x) => addOfferReminder(x, 'calc', label, d));
    setMsg(`Reminder saved for ${formatDate(d)}.`);
  };
  // Airtel 699
  const [prime, setPrime] = useState<'' | 'yes' | 'no'>('');
  const [avoid, setAvoid] = useState('');
  // cashback
  const [wallet, setWallet] = useState(false);
  const [upi, setUpi] = useState(true);
  const [reward, setReward] = useState('');
  const [used, setUsed] = useState(false);
  // jio cloud
  const [numberType, setNumberType] = useState<'' | 'jio' | 'non_jio'>('');
  const [start, setStart] = useState('');
  // google
  const [plan, setPlan] = useState<'plus' | 'pro'>('pro');
  const [trialEnd, setTrialEnd] = useState('');

  return (
    <div className="page">
      <h1>Scenario calculator</h1>
      <p className="muted">
        Enter your own assumptions. Every result is an estimate, not a promise. Verify in the
        official provider app/site.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {msg}
      </p>
      {msg && <p className="small">{msg}</p>}

      <section className="panel">
        <h2>{airtelPrime?.name ?? 'Airtel recharge with Amazon Prime'}</h2>
        <div className="grid">
          <label className="f" htmlFor="c1">
            Do you already have Prime?
            <select
              id="c1"
              value={prime}
              onChange={(e) => setPrime(e.target.value as typeof prime)}
            >
              <option value="">Not sure</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label className="f" htmlFor="c2">
            What you’d otherwise pay for Prime over the same period (₹)
            <small>Your own estimate for the same period.</small>
            <input
              id="c2"
              inputMode="decimal"
              value={avoid}
              onChange={(e) => setAvoid(e.target.value)}
            />
          </label>
        </div>
        <Result
          r={airtel699Prime({
            existingPrime: prime === '' ? null : prime === 'yes',
            avoidedPrimeCostPaise: avoid ? parseRupees(avoid) : null,
            documentedPricePaise: pricePaise(airtelPrime),
          })}
        />
        <SourceNote o={airtelPrime} />
      </section>

      <section className="panel">
        <h2>Airtel monthly cashback</h2>
        <div className="grid">
          <label className="check">
            <input type="checkbox" checked={wallet} onChange={(e) => setWallet(e.target.checked)} />{' '}
            Wallet variant
          </label>
          <label className="check">
            <input type="checkbox" checked={upi} onChange={(e) => setUpi(e.target.checked)} /> UPI
            variant
          </label>
          <label className="f" htmlFor="c3">
            Reward shown to you (₹)
            <input
              id="c3"
              inputMode="decimal"
              value={reward}
              onChange={(e) => setReward(e.target.value)}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={used} onChange={(e) => setUsed(e.target.checked)} /> I
            already used this month’s reward
          </label>
        </div>
        <Result
          r={airtelMonthlyCashback({
            variants: [...(wallet ? ['wallet' as const] : []), ...(upi ? ['upi' as const] : [])],
            rewardPaise: reward ? parseRupees(reward) : null,
            alreadyUsedThisMonth: used,
          })}
        />
        <p className="muted small">
          {PAYMENT_NOTE} Use the reward your Airtel app shows you; it is personalised.
        </p>
      </section>

      <section className="panel">
        <h2>JioAICloud</h2>
        <div className="grid">
          <label className="f" htmlFor="c4">
            Your number
            <select
              id="c4"
              value={numberType}
              onChange={(e) => setNumberType(e.target.value as typeof numberType)}
            >
              <option value="">Not sure</option>
              <option value="jio">Jio</option>
              <option value="non_jio">Non-Jio</option>
            </select>
          </label>
          {numberType === 'non_jio' && (
            <label className="f" htmlFor="c5">
              Trial start date
              <input id="c5" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
          )}
        </div>
        <Result
          r={jioAiCloud({
            numberType: numberType || null,
            trialStart: start || null,
            trialMonths: num(jioTrial?.benefitValue.trialMonths),
            storageGb: num(jioTrial?.benefitValue.storageGb),
          })}
          onRemind={remind('JioAICloud trial ends')}
          remindLabel="Remind me before the trial ends"
        />
        <SourceNote o={jioTrial} />
      </section>

      <section className="panel">
        <h2>Google AI trial</h2>
        <div className="grid">
          <label className="f" htmlFor="c6">
            Plan after the trial
            <select id="c6" value={plan} onChange={(e) => setPlan(e.target.value as typeof plan)}>
              <option value="pro">AI Pro</option>
              <option value="plus">AI Plus</option>
            </select>
          </label>
          <label className="f" htmlFor="c7">
            Trial end date (from your Google account)
            <input
              id="c7"
              type="date"
              value={trialEnd}
              onChange={(e) => setTrialEnd(e.target.value)}
            />
          </label>
        </div>
        <Result
          r={googleAiTrial({
            plan,
            trialEnd: trialEnd || null,
            documentedPricePaise: pricePaise(googlePlan(plan)),
          })}
          onRemind={remind('Decide on Google AI trial')}
          remindLabel="Remind me to decide"
        />
        <SourceNote o={googlePlan(plan)} />
        <p className="muted small">{PAYMENT_NOTE}</p>
      </section>
      <Disclaimer />
    </div>
  );
}
