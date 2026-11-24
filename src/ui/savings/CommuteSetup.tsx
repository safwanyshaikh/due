import { useState, type FormEvent } from 'react';
import type { CityPack, TransportMode } from '../../lib/savings/types';
import { Field, Notice } from '../components/ui';
import { useSavings } from './SavingsProvider';
import { profileEdits } from './engine';
import { MODES, MODE_LABEL, rupees } from './format';

/** City pack, home locality and commute legs. Everything stays on this device. */
export function CommuteSetup() {
  const { catalog, state, edit, phase } = useSavings();
  const p = state.profile;
  const packs: CityPack[] = catalog?.cityPacks ?? [];
  const pack = packs.find((c) => c.id === p.cityPack) ?? null;
  const localities = pack?.localities ?? [];

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [days, setDays] = useState('5');
  const [mode, setMode] = useState<TransportMode>('cab');
  const [cost, setCost] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const fromValue = from || p.homeLocality || '';
  const typical = pack?.typicalFareInr[mode];

  const addLeg = (e: FormEvent) => {
    e.preventDefault();
    const errs: string[] = [];
    const d = Number(days);
    const c = cost.trim() ? Number(cost.replace(/[₹,\s]/g, '')) : null;
    if (!fromValue.trim()) errs.push('Choose where the trip starts.');
    if (!to.trim()) errs.push('Choose where the trip goes.');
    if (fromValue && to && fromValue === to) errs.push('Start and destination are the same.');
    if (!Number.isInteger(d) || d < 1 || d > 7) errs.push('Days a week must be 1 to 7.');
    if (c !== null && (!Number.isFinite(c) || c < 0)) errs.push('Cost per trip must be a number.');
    setErrors(errs);
    if (errs.length) return;
    edit((s) =>
      profileEdits.upsertLeg(s, {
        from: fromValue.trim(),
        to: to.trim(),
        daysPerWeek: d,
        mode,
        costPerTripInr: c,
      }),
    );
    setTo('');
    setCost('');
  };

  return (
    <section className="panel2" aria-labelledby="sv-commute-h" data-testid="commute-setup">
      <div className="section-head">
        <h2 id="sv-commute-h">Your commute</h2>
      </div>
      <p className="muted small">
        Due compares what your regular trips cost with passes and shuttles on the same route. Saved
        on this device only.
      </p>
      {!packs.length ? (
        <p className="muted small">
          {phase === 'loading'
            ? 'Loading city information…'
            : 'City information isn’t available right now. Try again later.'}
        </p>
      ) : (
        <div className="inline-row">
          <Field label="City" htmlFor="sv-city">
            <select
              id="sv-city"
              value={p.cityPack ?? ''}
              onChange={(e) => {
                const v = e.target.value || null;
                edit((s) => profileEdits.setHome(profileEdits.setCity(s, v), null));
              }}
            >
              <option value="">Choose a city</option>
              {packs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Home area" htmlFor="sv-home">
            <select
              id="sv-home"
              value={p.homeLocality ?? ''}
              disabled={!pack}
              onChange={(e) => {
                const v = e.target.value || null;
                edit((s) => profileEdits.setHome(s, v));
              }}
            >
              <option value="">{pack ? 'Choose your area' : 'Choose a city first'}</option>
              {localities.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {p.commute.length > 0 && (
        <ul className="sv-legs" aria-label="Your regular trips">
          {p.commute.map((l) => (
            <li key={l.id} className="sv-leg">
              <div className="sv-leg-text">
                <strong>
                  {l.from} → {l.to}
                </strong>
                <span className="muted small">
                  {MODE_LABEL[l.mode]} · {l.daysPerWeek} day{l.daysPerWeek === 1 ? '' : 's'} a week
                  ·{' '}
                  {l.costPerTripInr === null
                    ? 'cost not set'
                    : `${rupees(l.costPerTripInr)} a trip`}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-quiet btn-sm press"
                aria-label={`Remove trip ${l.from} to ${l.to}`}
                onClick={() => edit((s) => profileEdits.removeLeg(s, l.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {pack && (
        <form
          className="stack-16 sv-leg-form"
          onSubmit={addLeg}
          noValidate
          aria-labelledby="sv-leg-h"
        >
          <h3 id="sv-leg-h" className="sv-h3">
            Add a regular trip
          </h3>
          {errors.length > 0 && (
            <Notice tone="warn" title="Please check">
              <ul className="errors2">
                {errors.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="inline-row">
            <Field label="From" htmlFor="sv-from">
              <select id="sv-from" value={fromValue} onChange={(e) => setFrom(e.target.value)}>
                <option value="">Choose</option>
                {localities.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="To" htmlFor="sv-to">
              <select id="sv-to" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Choose</option>
                {localities.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="inline-row">
            <Field label="How you travel" htmlFor="sv-mode">
              <select
                id="sv-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as TransportMode)}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Days a week" htmlFor="sv-days">
              <input
                id="sv-days"
                type="number"
                inputMode="numeric"
                min={1}
                max={7}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </Field>
            <Field
              label="Cost per trip (₹)"
              htmlFor="sv-cost"
              hint={
                typical
                  ? `Leave empty to use a typical ${rupees(typical)}, shown as an assumption you can change.`
                  : 'Optional. One way.'
              }
            >
              <input
                id="sv-cost"
                inputMode="decimal"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </Field>
          </div>
          <button type="submit" className="btn btn-secondary press jelly align-start">
            Add trip
          </button>
        </form>
      )}
    </section>
  );
}
