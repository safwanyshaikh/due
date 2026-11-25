// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { emptyData } from '../../lib/data';
import { addDays, todayInTz } from '../../lib/dates';
import { createObligation } from '../../lib/mutations';
import { rules } from '../../lib/recurrence';
import { addProfile, PERSONAL_PROFILE_ID, profileIdOf } from '../../lib/profiles';
import { STORAGE_KEY } from '../../lib/storage';
import type { Move } from '../../lib/savings/types';
import type { AppData } from '../../lib/types';
import { MoveSheet } from '../savings/MoveSheet';
import { renderApp, stubNetwork } from './harness';

const NOW = new Date().toISOString();

function stored(): AppData {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as AppData;
}

const STATEMENT = [
  '03/08/2026  NEFT CR-YESB0000001-PARTYCO INDUSTRIAL-REF100  45,000.00 Cr',
  '03/09/2026  NEFT CR-YESB0000001-PARTYCO INDUSTRIAL-REF200  38,000.00 Cr',
  '10/08/2026  IMPS/P2A/600000001/ABC ENTERPRISES LLP/HDFC0000001  12,000.00 Dr',
  '10/09/2026  IMPS/P2A/600000002/ABC ENTERPRISES LLP/HDFC0000001  12,500.00 Dr',
  '05/08/2026  NEFT/N0000001/RAVI KUMAR/SBIN0000001  5,000.00 Dr',
  '05/09/2026  NEFT/N0000002/RAVI KUMAR/SBIN0000001  5,000.00 Dr',
  '05/10/2026  UPI-AUTOPAY NETFLIX  649.00 Dr',
  '05/11/2026  UPI-AUTOPAY NETFLIX  649.00 Dr',
].join('\n');

function importStatement() {
  renderApp({ data: emptyData(), hash: '#/savings-import' });
  fireEvent.change(screen.getByLabelText('Or paste statement text'), {
    target: { value: STATEMENT },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Find repeat payments' }));
  return screen.getByTestId('entity-question');
}

function withBusiness(): { data: AppData; bizId: string } {
  const start = addDays(todayInTz(), 3);
  let d = createObligation(
    emptyData(),
    { type: 'subscription', provider: 'Netflix', amountPaise: 64_900, rule: rules.monthly(start) },
    { now: NOW },
  ).data;
  const r = addProfile(
    d,
    { name: 'ACME LLP', entityType: 'llp', role: 'designated_partner', gstRegistered: true },
    NOW,
  );
  d = createObligation(
    r.data,
    {
      type: 'bill',
      provider: 'Office internet',
      amountPaise: 118_000,
      rule: rules.monthly(addDays(start, 1)),
      profileId: r.profile.id,
    },
    { now: NOW },
  ).data;
  return { data: d, bizId: r.profile.id };
}

beforeEach(() => stubNetwork());
afterEach(() => cleanup());

describe('“Is this your business?” after a statement import', () => {
  it('asks one question at a time, people are never asked about', () => {
    const card = importStatement();
    expect(card).toHaveTextContent(
      'We see regular payments with ‘PARTYCO INDUSTRIAL’. Is this your business?',
    );
    expect(card).toHaveTextContent('1 of 2');
    expect(card).not.toHaveTextContent('RAVI');
    for (const label of [
      'Yes, I own/run it',
      'I work there',
      'Family business',
      'Not mine',
      'Ask later',
    ])
      expect(within(card).getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
  });

  it('Yes → entity type, role and GST, each with a line on what it changes → a business profile', () => {
    const card = importStatement();
    fireEvent.click(within(card).getByRole('button', { name: /Yes, I own\/run it/ }));
    const llp = within(card).getByRole('radio', { name: /^LLP/ });
    expect(within(card).getByText(/A Private Limited’s loans are the company’s/)).toBeVisible();
    // Nothing is chosen for the person.
    expect(
      within(card)
        .getAllByRole('radio')
        .some((r) => (r as HTMLInputElement).checked),
    ).toBe(false);
    fireEvent.click(within(card).getByRole('button', { name: 'Save business' }));
    expect(within(card).getByRole('alert')).toHaveTextContent('Choose one answer in each group.');
    fireEvent.click(llp);
    fireEvent.click(within(card).getByRole('radio', { name: /Designated partner/ }));
    fireEvent.click(within(card).getByRole('radio', { name: /^Yes/ }));
    fireEvent.click(within(card).getByRole('button', { name: 'Save business' }));
    const d = stored();
    const biz = d.profiles.find((p) => p.name === 'PARTYCO INDUSTRIAL')!;
    expect(biz).toMatchObject({
      kind: 'business',
      entityType: 'llp',
      role: 'designated_partner',
      samePanAsOwner: false,
      gstRegistered: true,
    });
    expect(d.profileDecisions).toEqual([
      expect.objectContaining({ name: 'PARTYCO INDUSTRIAL', answer: 'own', profileId: biz.id }),
    ]);
    // The next question follows.
    expect(screen.getByTestId('entity-question')).toHaveTextContent('ABC ENTERPRISES LLP');
    expect(screen.getByTestId('entity-question')).toHaveTextContent('2 of 2');
  });

  it('a proprietorship has one role: no role question; it shares the owner’s PAN', () => {
    const card = importStatement();
    fireEvent.click(within(card).getByRole('button', { name: /Yes, I own\/run it/ }));
    fireEvent.click(within(card).getByRole('radio', { name: /Just me, on my PAN/ }));
    expect(within(card).queryByText('How are you linked to it?')).toBeNull();
    const gst = within(card).getByRole('group', { name: 'GST registered?' });
    fireEvent.click(within(gst).getByRole('radio', { name: /Not sure/ }));
    fireEvent.click(within(card).getByRole('button', { name: 'Save business' }));
    const biz = stored().profiles.find((p) => p.name === 'PARTYCO INDUSTRIAL')!;
    expect(biz).toMatchObject({
      entityType: 'proprietorship',
      role: 'proprietor',
      samePanAsOwner: true,
      gstRegistered: null,
    });
  });

  it('Not mine and I work there are remembered; Ask later goes to Settings → Profiles', () => {
    const card = importStatement();
    fireEvent.click(within(card).getByRole('button', { name: /Not mine/ }));
    fireEvent.click(
      within(screen.getByTestId('entity-question')).getByRole('button', { name: /Ask later/ }),
    );
    expect(screen.queryByTestId('entity-question')).toBeNull();
    expect(screen.getByTestId('entity-question-done')).toHaveTextContent('Settings → Profiles');
    const d = stored();
    expect(d.profiles).toHaveLength(1);
    expect(d.profileDecisions.map((x) => [x.name, x.answer])).toEqual([
      ['PARTYCO INDUSTRIAL', 'not_mine'],
      ['ABC ENTERPRISES LLP', 'later'],
    ]);
    cleanup();
    renderApp({ data: d, hash: '#/profiles' });
    const saved = screen.getByTestId('entity-question');
    expect(saved).toHaveTextContent('Questions you saved');
    expect(saved).toHaveTextContent('ABC ENTERPRISES LLP');
    expect(screen.getByText('Names you answered')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ask again about PARTYCO INDUSTRIAL' }));
    expect(stored().profileDecisions.map((x) => x.name)).toEqual(['ABC ENTERPRISES LLP']);
  });
});

describe('profile switcher', () => {
  it('is not shown while there is only Personal', () => {
    renderApp({ data: emptyData() });
    expect(screen.queryByTestId('profile-switcher')).toBeNull();
  });

  it('All · Personal · <Business> filters Home', () => {
    const { data } = withBusiness();
    renderApp({ data });
    const sw = screen.getByTestId('profile-switcher');
    const radios = within(sw).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['All', 'Personal', 'ACME LLP']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    const summary = () => document.querySelector('[data-block="summary"]')!;
    expect(summary()).toHaveTextContent('Netflix');
    fireEvent.click(radios[2]);
    expect(summary()).toHaveTextContent('Office internet');
    expect(summary()).toHaveTextContent('₹1,180');
    expect(screen.getByTestId('profile-scope-note')).toHaveTextContent(
      'Its loans are the LLP’s, not yours, unless you signed as guarantor.',
    );
    fireEvent.click(within(sw).getByRole('radio', { name: 'Personal' }));
    expect(summary()).toHaveTextContent('Netflix');
    expect(summary()).not.toHaveTextContent('Office internet');
    // Arrow keys move along the group.
    fireEvent.keyDown(sw, { key: 'ArrowRight' });
    expect(within(sw).getByRole('radio', { name: 'ACME LLP' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('Savings has the same filter', () => {
    const { data } = withBusiness();
    renderApp({ data, hash: '#/savings' });
    expect(screen.getByTestId('profile-switcher')).toBeInTheDocument();
  });
});

describe('Belongs to', () => {
  it('the add form saves the chosen profile; a separate entity’s loan asks how you signed', () => {
    const { data, bizId } = withBusiness();
    renderApp({ data, hash: '#/add' });
    fireEvent.click(screen.getByRole('radio', { name: 'EMI' }));
    fireEvent.change(screen.getByLabelText('Belongs to'), { target: { value: bizId } });
    expect(screen.getByTestId('whose-due')).toHaveTextContent('The business’s');
    fireEvent.change(screen.getByLabelText('Did you sign this loan too?'), {
      target: { value: 'guarantor' },
    });
    expect(screen.getByTestId('whose-due')).toHaveTextContent('can come to you');
    fireEvent.change(screen.getByLabelText('Who is it with?'), {
      target: { value: 'Business loan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save due item' }));
    const c = stored().commitments.find((x) => x.provider === 'Business loan')!;
    expect(c).toMatchObject({ profileId: bizId, signedAs: 'guarantor' });
  });

  it('a partnership firm’s dues show as able to come to you', () => {
    const firm = addProfile(
      emptyData(),
      { name: 'ACME & Co', entityType: 'partnership', role: 'partner', gstRegistered: null },
      NOW,
    );
    renderApp({ data: firm.data, hash: '#/add' });
    fireEvent.change(screen.getByLabelText('Belongs to'), { target: { value: firm.profile.id } });
    expect(screen.getByTestId('whose-due')).toHaveTextContent('Can come to you');
  });

  it('without a business, the form points to Settings → Profiles instead', () => {
    renderApp({ data: emptyData(), hash: '#/add' });
    expect(screen.queryByLabelText('Belongs to')).toBeNull();
    expect(screen.getByRole('link', { name: 'Add a business profile' })).toHaveAttribute(
      'href',
      '#/profiles',
    );
  });
});

describe('Settings → Profiles', () => {
  it('adds one business on Free, then shows the plan note instead of a second', () => {
    renderApp({ data: emptyData(), hash: '#/profiles' });
    fireEvent.click(screen.getByRole('button', { name: 'Add a business' }));
    fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'ACME Traders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add business' }));
    const d = stored();
    expect(d.profiles.map((p) => [p.name, p.entityType, p.samePanAsOwner])).toEqual([
      ['Personal', 'individual', true],
      ['ACME Traders', 'proprietorship', true],
    ]);
    expect(screen.getByText(/Free includes Personal and one business/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a business' })).toBeNull();
  });

  it('deleting a business moves its dues to Personal', () => {
    const { data, bizId } = withBusiness();
    renderApp({ data, hash: '#/profiles' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete ACME LLP' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete it' }));
    const d = stored();
    expect(d.profiles.map((p) => p.id)).toEqual([PERSONAL_PROFILE_ID]);
    expect(d.commitments).toHaveLength(2);
    expect(d.commitments.every((c) => profileIdOf(c, d) === PERSONAL_PROFILE_ID)).toBe(true);
    expect(d.profiles.some((p) => p.id === bizId)).toBe(false);
  });

  it('merging a business into Personal keeps every due', () => {
    const { data } = withBusiness();
    renderApp({ data, hash: '#/profiles' });
    const card = document.querySelector<HTMLElement>(
      '[data-profile-card]:not([data-profile-card="personal"])',
    )!;
    expect(within(card).getByTestId('profile-total')).toHaveTextContent('1 due');
    fireEvent.click(within(card).getByRole('button', { name: 'Merge ACME LLP' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Yes, merge' }));
    const d = stored();
    expect(d.profiles).toHaveLength(1);
    expect(d.commitments).toHaveLength(2);
  });

  it('is linked from Settings', () => {
    renderApp({ data: emptyData(), hash: '#/settings' });
    expect(screen.getByRole('link', { name: /Profiles: personal and business/ })).toHaveAttribute(
      'href',
      '#/profiles',
    );
  });
});

describe('move sheet', () => {
  it('shows the GST information line for a business move', () => {
    const move: Move = {
      id: 'period_switch:x',
      kind: 'period_switch',
      moduleId: null,
      obligationIds: ['x'],
      title: 'Switch to yearly',
      why: 'Cheaper per month',
      monthlySavingInr: 100,
      rangeInr: [80, 120],
      confidence: 'medium',
      assumptions: [],
      sources: [],
      effort: 'tap',
      action: { url: null, label: '' },
      unverifiedPrice: false,
      legalNote: null,
      sponsored: false,
    };
    render(
      <MoveSheet
        move={move}
        status="new"
        onClose={() => undefined}
        onMark={() => undefined}
        onOverride={() => undefined}
        profileNote="Business expense? A GST-registered business may be able to claim input tax credit — check with your CA."
      />,
    );
    expect(screen.getByTestId('move-profile-note')).toHaveTextContent('check with your CA');
  });
});
