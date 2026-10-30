import { useState } from 'react';
import { useApp } from '../store';
import type { Nav } from '../App';
import {
  Disclaimer,
  PROVIDER_CHOICES,
  PendingBadge,
  SourceLink,
  StatusBadge,
  useCatalog,
  useCatalogEmpty,
} from './parts';
import { blankService, upsertService } from '../../lib/offers/services';
import {
  completeness,
  evaluateEligibility,
  matchSummary,
  offersForService,
} from '../../lib/offers/eligibility';
import { isRecommendable } from '../../lib/offers/status';
import { PRIVATE_NOTE } from '../../lib/offers/copy';
import { parseRupees } from '../../lib/money';
import { isValidISO } from '../../lib/dates';
import { looksSensitive } from '../../lib/sensitive';
import type { ServiceType, UserServiceRecord } from '../../lib/offers/types';

type Tri = '' | 'yes' | 'no';
const tri = (v: Tri) => (v === '' ? null : v === 'yes');

export function AddService({ nav }: { nav: Nav }) {
  const { today, update } = useApp();
  const { offers: catalog } = useCatalog();
  const catalogEmpty = useCatalogEmpty();
  const [step, setStep] = useState(1);
  const [s, setS] = useState<UserServiceRecord>(() => blankService('jio', today));
  const [price, setPrice] = useState('');
  const [existing, setExisting] = useState<Tri>('');
  const [claim, setClaim] = useState<Tri>('');
  const [errors, setErrors] = useState<string[]>([]);
  const choice = PROVIDER_CHOICES.find((p) => p.id === s.provider)!;
  const set = <K extends keyof UserServiceRecord>(k: K, v: UserServiceRecord[K]) =>
    setS((p) => ({ ...p, [k]: v }));
  const telecom = ['jio', 'airtel', 'vi'].includes(s.provider);

  const draft: UserServiceRecord = {
    ...s,
    approxPricePaise: price.trim() ? parseRupees(price) : null,
    existingSubscription: tri(existing),
    claimCardVisible: tri(claim),
  };
  const offers = offersForService(draft, catalog);
  const comp = completeness(draft, offers);
  const matches = offers.filter((o) => isRecommendable(o.computedStatus));

  function next() {
    const errs: string[] = [];
    if (step === 3) {
      if (price.trim() && draft.approxPricePaise === null)
        errs.push('Price should be a rupee value like 699.');
      for (const d of [s.renewalDate, s.trialEnd, s.claimDeadline, s.benefitExpiry])
        if (d && !isValidISO(d)) errs.push('One of the dates is not valid.');
      const sens = looksSensitive(
        [s.label, s.planName, s.circle, s.partnerName, s.notes].join(' '),
      );
      if (sens) errs.push(sens);
    }
    setErrors(errs);
    if (!errs.length) setStep(step + 1);
  }
  function save() {
    const rec = {
      ...draft,
      label:
        draft.label.trim() ||
        `${choice.label} ${choice.types.find((t) => t.id === s.serviceType)?.label ?? ''}`.trim(),
    };
    update((d) => upsertService(d, rec));
    nav.go({ name: 'service', id: rec.id });
  }

  const steps = ['Provider', 'Service type', 'Your details', 'Review'];
  return (
    <div className="page">
      <h1>Add a provider or service</h1>
      <ol className="stepper-list" aria-label="Steps">
        {steps.map((t, i) => (
          <li
            key={t}
            aria-current={step === i + 1 ? 'step' : undefined}
            className={step === i + 1 ? 'on' : step > i + 1 ? 'done' : ''}
          >
            {i + 1}. {t}
          </li>
        ))}
      </ol>
      <p className="muted small">
        {PRIVATE_NOTE} Due never asks for passwords, OTPs, card numbers, bank details, Aadhaar/KYC
        or your SIM.
      </p>

      {step === 1 && (
        <fieldset className="panel">
          <legend>Which provider or service?</legend>
          <div className="seg4">
            {PROVIDER_CHOICES.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={s.provider === p.id}
                onClick={() =>
                  setS({
                    ...blankService(p.id, today),
                    id: s.id,
                    serviceType: p.types[0].id as ServiceType,
                  })
                }
              >
                {p.label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {step === 2 && (
        <fieldset className="panel">
          <legend>What kind of service?</legend>
          <div className="seg4">
            {choice.types.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={s.serviceType === t.id}
                onClick={() => set('serviceType', t.id as ServiceType)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {step === 3 && (
        <section className="panel">
          <p className="muted small">Everything here is optional. Fill in only what you know.</p>
          <div className="grid">
            <label className="f" htmlFor="sLabel">
              Your name for it
              <input
                id="sLabel"
                value={s.label}
                onChange={(e) => set('label', e.target.value)}
                placeholder="e.g. My phone plan"
              />
            </label>
            <label className="f" htmlFor="sPlan">
              Plan name or code
              <input
                id="sPlan"
                value={s.planName ?? ''}
                onChange={(e) => set('planName', e.target.value)}
              />
            </label>
            <label className="f" htmlFor="sPrice">
              Approximate price (₹)
              <input
                id="sPrice"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            {telecom && (
              <label className="f" htmlFor="sCircle">
                Circle or state
                <input
                  id="sCircle"
                  value={s.circle ?? ''}
                  onChange={(e) => set('circle', e.target.value)}
                />
              </label>
            )}
            {telecom && (
              <label className="f" htmlFor="sTenure">
                Months with this provider
                <input
                  id="sTenure"
                  type="number"
                  min={0}
                  value={s.tenureMonths ?? ''}
                  onChange={(e) =>
                    set('tenureMonths', e.target.value === '' ? null : Number(e.target.value))
                  }
                />
              </label>
            )}
            {s.provider === 'jio' && (
              <label className="f" htmlFor="sNum">
                Number type
                <select
                  id="sNum"
                  value={s.numberType ?? ''}
                  onChange={(e) =>
                    set('numberType', (e.target.value || null) as UserServiceRecord['numberType'])
                  }
                >
                  <option value="">Not sure</option>
                  <option value="jio">Jio number</option>
                  <option value="non_jio">Non-Jio number</option>
                </select>
              </label>
            )}
            {['airtel', 'amazon', 'google'].includes(s.provider) && (
              <label className="f" htmlFor="sExist">
                {s.provider === 'google'
                  ? 'Do you already have this Google plan?'
                  : 'Do you already have Amazon Prime?'}
                <select
                  id="sExist"
                  value={existing}
                  onChange={(e) => setExisting(e.target.value as Tri)}
                >
                  <option value="">Not sure</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
            )}
            {['airtel', 'google'].includes(s.provider) && (
              <label className="f" htmlFor="sDev">
                Device
                <select
                  id="sDev"
                  value={s.device ?? ''}
                  onChange={(e) =>
                    set('device', (e.target.value || null) as UserServiceRecord['device'])
                  }
                >
                  <option value="">Not sure</option>
                  <option value="android">Android</option>
                  <option value="ios">iPhone / iPad</option>
                  <option value="other">Other</option>
                </select>
              </label>
            )}
            {s.provider === 'airtel' && (
              <label className="f" htmlFor="sClaim">
                Do you see a claim card in the Airtel app?
                <small>Your own answer. Due can’t see your account.</small>
                <select id="sClaim" value={claim} onChange={(e) => setClaim(e.target.value as Tri)}>
                  <option value="">Not sure</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
            )}
            {s.provider === 'vi' && (
              <label className="f" htmlFor="sOtt">
                OTT apps in your pack<small>As shown in your Vi app.</small>
                <input
                  id="sOtt"
                  type="number"
                  min={0}
                  value={s.selectedOttCount ?? ''}
                  onChange={(e) =>
                    set('selectedOttCount', e.target.value === '' ? null : Number(e.target.value))
                  }
                />
              </label>
            )}
            {['amazon', 'google'].includes(s.provider) && (
              <label className="f" htmlFor="sBill">
                Who bills you?
                <select
                  id="sBill"
                  value={s.billedThrough ?? ''}
                  onChange={(e) =>
                    set(
                      'billedThrough',
                      (e.target.value || null) as UserServiceRecord['billedThrough'],
                    )
                  }
                >
                  <option value="">Not sure</option>
                  <option value="direct">
                    {s.provider === 'google' ? 'Google directly' : 'Amazon directly'}
                  </option>
                  <option value="google_play">Google Play</option>
                  <option value="apple">Apple</option>
                  <option value="partner">A partner (e.g. a telecom)</option>
                </select>
              </label>
            )}
            {s.billedThrough === 'partner' && (
              <label className="f" htmlFor="sPartner">
                Partner name
                <input
                  id="sPartner"
                  value={s.partnerName ?? ''}
                  onChange={(e) => set('partnerName', e.target.value)}
                />
              </label>
            )}
            {(s.provider === 'cards_upi' || s.provider === 'vi') && (
              <label className="f" htmlFor="sRail">
                Payment app or rail for a specific reward
                <small>Only to compare documented conditions.</small>
                <select
                  id="sRail"
                  value={s.paymentRail ?? ''}
                  onChange={(e) =>
                    set('paymentRail', (e.target.value || null) as UserServiceRecord['paymentRail'])
                  }
                >
                  <option value="">Not relevant</option>
                  <option value="upi">UPI</option>
                  <option value="wallet">Wallet</option>
                  <option value="card">Card</option>
                  <option value="other">Other</option>
                </select>
              </label>
            )}
            {s.provider === 'cards_upi' && (
              <label className="f" htmlFor="sApp">
                Partner app
                <select
                  id="sApp"
                  value={s.partnerAppStatus ?? ''}
                  onChange={(e) =>
                    set(
                      'partnerAppStatus',
                      (e.target.value || null) as UserServiceRecord['partnerAppStatus'],
                    )
                  }
                >
                  <option value="">Not sure</option>
                  <option value="new">New user</option>
                  <option value="existing">Existing user</option>
                </select>
              </label>
            )}
            <label className="f" htmlFor="sRenew">
              Renewal date
              <input
                id="sRenew"
                type="date"
                value={s.renewalDate ?? ''}
                onChange={(e) => set('renewalDate', e.target.value || null)}
              />
            </label>
            <label className="f" htmlFor="sTrial">
              Trial ends
              <input
                id="sTrial"
                type="date"
                value={s.trialEnd ?? ''}
                onChange={(e) => set('trialEnd', e.target.value || null)}
              />
            </label>
            <label className="f" htmlFor="sClaimBy">
              Claim deadline
              <input
                id="sClaimBy"
                type="date"
                value={s.claimDeadline ?? ''}
                onChange={(e) => set('claimDeadline', e.target.value || null)}
              />
            </label>
            <label className="f" htmlFor="sExp">
              Benefit expires
              <input
                id="sExp"
                type="date"
                value={s.benefitExpiry ?? ''}
                onChange={(e) => set('benefitExpiry', e.target.value || null)}
              />
            </label>
          </div>
        </section>
      )}
      {step === 4 && (
        <section className="panel">
          <h2>Review</h2>
          <p>
            {comp.total
              ? `${comp.filled} of ${comp.total} useful details filled in.`
              : 'No extra details are needed for these records.'}
          </p>
          {comp.missing.length > 0 && (
            <p className="muted small">
              Missing: {comp.missing.join('; ')}. Matches stay uncertain until you add these or the
              provider confirms them.
            </p>
          )}
          <p className="muted small">
            Some conditions can only be confirmed by the provider, such as your circle, tier or a
            selected-user campaign.
          </p>
          <h3>Possible matches</h3>
          {matches.length === 0 && (
            <p className="muted small">
              {catalogEmpty.empty
                ? catalogEmpty.message
                : 'No current documented benefits for this provider from Due’s monitoring service.'}
            </p>
          )}
          <ul className="srcs">
            {matches.map((o) => (
              <li key={o.offerId}>
                <a href={`#/offer/${o.offerId}`}>{o.name}</a> <StatusBadge s={o.computedStatus} />{' '}
                <PendingBadge o={o} />{' '}
                <span className="small">
                  {matchSummary(evaluateEligibility(o, draft)) === 'may_not_qualify'
                    ? 'You may not qualify — verify.'
                    : 'May qualify — verify in the provider app.'}
                </span>
                {o.sources[0] && (
                  <>
                    <br />
                    <SourceLink s={o.sources[0]} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {errors.length > 0 && (
        <ul className="errors" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        {step > 1 && (
          <button className="btn quiet" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < 4 ? (
          <button className="btn primary" onClick={next}>
            Continue
          </button>
        ) : (
          <button className="btn primary" onClick={save}>
            Save service
          </button>
        )}
      </div>
      <Disclaimer />
    </div>
  );
}
