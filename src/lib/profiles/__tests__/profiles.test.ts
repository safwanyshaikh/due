import { describe, expect, it } from 'vitest';
import { emptyData } from '../../data';
import { createObligation, updateObligation } from '../../mutations';
import { downgradeToV1, migrateData } from '../../migrate';
import { loadData, saveData, STORAGE_KEY } from '../../storage';
import { rules } from '../../recurrence';
import { FREE_ENTITLEMENT, type Entitlement } from '../../plans';
import type { AppData } from '../../types';
import {
  PERSONAL_PROFILE_ID,
  addProfile,
  assignProfile,
  canAddBusinessProfile,
  deleteProfile,
  ensureProfiles,
  gstNoteFor,
  liabilityOwner,
  mergeProfiles,
  moveProfileId,
  profileIdOf,
  profileTotals,
  rolesFor,
  yourExposurePaise,
  samePanFor,
  scopeData,
  updateProfile,
  validSelection,
  withMoveProfiles,
} from '..';
import type { Move } from '../../savings/types';

const NOW = '2026-11-25T10:00:00.000Z';
const ctx = { now: NOW, today: '2026-11-25', actor: 'user' as const };

function withDue(
  d: AppData,
  provider: string,
  amountPaise: number | null,
  type: 'subscription' | 'emi' | 'bill' = 'subscription',
  profileId?: string,
) {
  return createObligation(
    d,
    { type, provider, amountPaise, rule: rules.monthly('2026-12-05'), profileId },
    ctx,
  ).data;
}

function business(
  d: AppData,
  name: string,
  entityType: 'proprietorship' | 'llp' | 'private_limited' | 'partnership' | 'huf',
  role: Parameters<typeof addProfile>[1]['role'],
  gst: boolean | null = null,
) {
  return addProfile(d, { name, entityType, role, gstRegistered: gst }, NOW);
}

describe('defaults and migration', () => {
  it('a new dataset has one Personal profile and no decisions', () => {
    const d = emptyData();
    expect(d.profiles).toHaveLength(1);
    expect(d.profiles[0]).toMatchObject({
      id: PERSONAL_PROFILE_ID,
      kind: 'personal',
      name: 'Personal',
      entityType: 'individual',
      role: 'self',
      samePanAsOwner: true,
      gstRegistered: null,
    });
    expect(d.profileDecisions).toEqual([]);
  });

  it('old data (no profiles) gains Personal; its dues stay untouched and count as Personal', () => {
    const base = withDue(emptyData(), 'Netflix', 64900);
    const { profiles: _p, profileDecisions: _d, ...old } = base;
    void [_p, _d];
    const before = structuredClone(old.commitments[0]);
    delete (before as { profileId?: string }).profileId;
    const legacy = { ...old, commitments: [before] };
    const store = new Map([[STORAGE_KEY, JSON.stringify(legacy)]]);
    const s = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const once = loadData(s)!;
    expect(once.profiles.map((p) => p.id)).toEqual([PERSONAL_PROFILE_ID]);
    expect(once.commitments[0]).toEqual(before);
    expect(profileIdOf(once.commitments[0], once)).toBe(PERSONAL_PROFILE_ID);
    saveData(once, s);
    const twice = loadData(s)!;
    expect(twice).toEqual(once);
    expect(migrateData(twice)).toEqual(twice);
  });

  it('repairs damaged profiles: Personal first, derived PAN flag, dangling dues to Personal', () => {
    const d = withDue(emptyData(), 'Rent', 100000);
    const broken = {
      ...d,
      profiles: [
        {
          id: 'pf_1',
          kind: 'business',
          name: '  ACME  LLP ',
          entityType: 'llp',
          role: 'partner',
          samePanAsOwner: true,
          gstRegistered: 'yes',
          createdAt: NOW,
        },
        { id: 'pf_1', kind: 'business', name: 'Duplicate id', entityType: 'llp' },
        { id: 'pf_2', kind: 'personal', name: 'Second personal', entityType: 'weird' },
        { name: 'no id' },
        null,
      ],
      profileDecisions: [
        { key: 'x', answer: 'nonsense' },
        { key: 'acme', name: 'ACME', answer: 'not_mine', at: NOW },
      ],
      commitments: [{ ...d.commitments[0], profileId: 'pf_gone', signedAs: 'surety' }],
    } as unknown as AppData;
    const out = ensureProfiles(broken, NOW);
    expect(out.profiles.map((p) => [p.id, p.kind, p.name])).toEqual([
      [PERSONAL_PROFILE_ID, 'personal', 'Personal'],
      ['pf_1', 'business', 'ACME LLP'],
      ['pf_2', 'business', 'Second personal'],
    ]);
    expect(out.profiles[1].samePanAsOwner).toBe(false);
    expect(out.profiles[1].gstRegistered).toBeNull();
    expect(out.profiles[2].entityType).toBe('other');
    expect(out.profileDecisions).toHaveLength(1);
    expect(out.commitments[0].profileId).toBe(PERSONAL_PROFILE_ID);
    expect(out.commitments[0].signedAs).toBeNull();
    expect(ensureProfiles(out, NOW)).toEqual(out);
  });

  it('a downgrade for older builds strips profile fields', () => {
    const r = business(
      withDue(emptyData(), 'Rent', 100000),
      'ACME LLP',
      'llp',
      'designated_partner',
    );
    const d = assignProfile(r.data, r.data.commitments[0].id, r.profile.id, NOW);
    const v1 = downgradeToV1(d) as unknown as Record<string, unknown>;
    expect(v1.profiles).toBeUndefined();
    expect(v1.profileDecisions).toBeUndefined();
    expect((v1.commitments as Record<string, unknown>[])[0].profileId).toBeUndefined();
  });
});

describe('legal identity', () => {
  it('only individuals and proprietorships share the owner’s PAN', () => {
    expect(samePanFor('individual')).toBe(true);
    expect(samePanFor('proprietorship')).toBe(true);
    for (const t of [
      'partnership',
      'llp',
      'private_limited',
      'opc',
      'huf',
      'trust',
      'other',
    ] as const)
      expect(samePanFor(t)).toBe(false);
    expect(rolesFor('proprietorship')).toEqual(['proprietor']);
    expect(rolesFor('llp')[0]).toBe('designated_partner');
    expect(rolesFor('private_limited')).toContain('guarantor');
  });

  it('liabilityOwner: you, the entity, or you as guarantor', () => {
    let d = withDue(emptyData(), 'Home loan', 2000000, 'emi');
    const prop = business(d, 'ACME Traders', 'proprietorship', 'proprietor');
    d = prop.data;
    const llp = business(d, 'ABC Enterprises LLP', 'llp', 'designated_partner');
    d = llp.data;
    const pvt = business(d, 'PARTYCO Pvt Ltd', 'private_limited', 'guarantor');
    d = pvt.data;
    const personalLoan = d.commitments[0];
    expect(liabilityOwner(personalLoan, d)).toBe('you');
    expect(liabilityOwner({ ...personalLoan, profileId: prop.profile.id }, d)).toBe('you');
    expect(liabilityOwner({ ...personalLoan, profileId: llp.profile.id }, d)).toBe('entity');
    expect(
      liabilityOwner({ ...personalLoan, profileId: llp.profile.id, signedAs: 'co_applicant' }, d),
    ).toBe('you_as_guarantor');
    // Guarantor of the company: its loans can come to you, its other bills do not.
    expect(liabilityOwner({ ...personalLoan, profileId: pvt.profile.id }, d)).toBe(
      'you_as_guarantor',
    );
    expect(liabilityOwner({ ...personalLoan, type: 'bill', profileId: pvt.profile.id }, d)).toBe(
      'entity',
    );
  });
});

describe('unlimited liability: partnership partners and HUF karta', () => {
  it('a partner of a firm: every due can come to you, listed under the firm', () => {
    let d = withDue(emptyData(), 'Rent', 100000);
    const firm = business(d, 'ACME & Co', 'partnership', 'partner');
    d = withDue(firm.data, 'Shop rent', 200000, 'bill', firm.profile.id);
    d = withDue(d, 'Firm loan', 900000, 'emi', firm.profile.id);
    for (const c of d.commitments.slice(1)) expect(liabilityOwner(c, d)).toBe('you_as_partner');
    const t = profileTotals(d).find((x) => x.profileId === firm.profile.id)!;
    expect(t.byOwner).toEqual({ you: 0, entity: 0, you_as_guarantor: 0, you_as_partner: 1100000 });
    expect(t.exposurePaise).toBe(1100000);
    expect(yourExposurePaise(d)).toBe(1200000);
    // Working at the firm is not being a partner.
    const staff = updateProfile(d, firm.profile.id, { role: 'employee' });
    expect(liabilityOwner(staff.commitments[1], staff)).toBe('entity');
  });

  it('LLP partners and Pvt Ltd directors stay the entity’s unless they signed', () => {
    let d = emptyData();
    const llp = business(d, 'ABC Enterprises LLP', 'llp', 'partner');
    d = withDue(llp.data, 'LLP loan', 900000, 'emi', llp.profile.id);
    expect(liabilityOwner(d.commitments[0], d)).toBe('entity');
    const pvt = business(d, 'PARTYCO Pvt Ltd', 'private_limited', 'director');
    d = withDue(pvt.data, 'Company loan', 900000, 'emi', pvt.profile.id);
    expect(liabilityOwner(d.commitments[1], d)).toBe('entity');
    expect(liabilityOwner({ ...d.commitments[1], signedAs: 'guarantor' }, d)).toBe(
      'you_as_guarantor',
    );
  });

  it('the karta of an HUF: its dues can come to you; another member’s do not', () => {
    expect(rolesFor('huf')[0]).toBe('karta');
    let d = emptyData();
    const huf = business(d, 'RAVI KUMAR HUF', 'huf', 'karta');
    d = withDue(huf.data, 'HUF property tax', 50000, 'bill', huf.profile.id);
    expect(liabilityOwner(d.commitments[0], d)).toBe('you_as_partner');
    const member = updateProfile(d, huf.profile.id, { role: 'other' });
    expect(liabilityOwner(member.commitments[0], member)).toBe('entity');
  });
});

describe('scope, totals and edits', () => {
  function setup() {
    let d = withDue(emptyData(), 'Netflix', 64900);
    const r = business(d, 'ABC Enterprises LLP', 'llp', 'designated_partner', true);
    d = r.data;
    d = withDue(d, 'Office internet', 118000, 'bill', r.profile.id);
    d = withDue(d, 'Business loan', 5000000, 'emi', r.profile.id);
    d = withDue(d, 'Software', null, 'subscription', r.profile.id);
    return { d, biz: r.profile };
  }

  it('scopeData shows one profile’s dues; all shows everything', () => {
    const { d, biz } = setup();
    expect(scopeData(d, 'all')).toBe(d);
    expect(scopeData(d, PERSONAL_PROFILE_ID).commitments.map((c) => c.provider)).toEqual([
      'Netflix',
    ]);
    expect(scopeData(d, biz.id).commitments).toHaveLength(3);
    expect(validSelection(d, 'pf_gone')).toBe('all');
    expect(validSelection(d, biz.id)).toBe(biz.id);
  });

  it('profileTotals per profile, split by who has to pay, unknown amounts not zero', () => {
    const { d, biz } = setup();
    const [personal, b] = profileTotals(d);
    expect(personal).toMatchObject({
      profileId: PERSONAL_PROFILE_ID,
      count: 1,
      monthlyPaise: 64900,
    });
    expect(personal.byOwner.you).toBe(64900);
    expect(b).toMatchObject({
      profileId: biz.id,
      count: 3,
      monthlyPaise: 5118000,
      unknownCount: 1,
    });
    expect(b.byOwner).toEqual({ you: 0, entity: 5118000, you_as_guarantor: 0, you_as_partner: 0 });
    expect(b.exposurePaise).toBe(0);
    expect(personal.exposurePaise).toBe(64900);
    const signed = updateObligation(d, d.commitments[2].id, { signedAs: 'guarantor' }, ctx).data;
    expect(profileTotals(signed)[1].byOwner).toEqual({
      you: 0,
      entity: 118000,
      you_as_guarantor: 5000000,
      you_as_partner: 0,
    });
    expect(profileTotals(signed)[1].exposurePaise).toBe(5000000);
    expect(yourExposurePaise(signed)).toBe(5064900);
  });

  it('delete moves dues to Personal; merge moves them into another profile', () => {
    const { d, biz } = setup();
    expect(() => deleteProfile(d, PERSONAL_PROFILE_ID, NOW)).toThrow();
    const del = deleteProfile(d, biz.id, NOW);
    expect(del.profiles).toHaveLength(1);
    expect(del.commitments).toHaveLength(4);
    expect(del.commitments.every((c) => profileIdOf(c, del) === PERSONAL_PROFILE_ID)).toBe(true);

    const other = business(d, 'ABC LLP', 'llp', 'partner');
    const merged = mergeProfiles(other.data, biz.id, other.profile.id, NOW);
    expect(merged.profiles.map((p) => p.name)).toEqual(['Personal', 'ABC LLP']);
    expect(merged.commitments.filter((c) => c.profileId === other.profile.id)).toHaveLength(3);
    expect(() => mergeProfiles(d, PERSONAL_PROFILE_ID, biz.id, NOW)).toThrow();
  });

  it('names must be unique and present; entity type keeps the PAN flag in step', () => {
    const { d, biz } = setup();
    expect(() => business(d, 'abc enterprises llp', 'llp', 'partner')).toThrow(/already/);
    expect(() => business(d, '   ', 'llp', 'partner')).toThrow(/name/);
    const up = updateProfile(d, biz.id, { entityType: 'proprietorship', role: 'proprietor' });
    expect(up.profiles[1]).toMatchObject({ samePanAsOwner: true, entityType: 'proprietorship' });
    const personal = updateProfile(d, PERSONAL_PROFILE_ID, { name: 'Mine', entityType: 'llp' });
    expect(personal.profiles[0]).toMatchObject({ name: 'Personal', entityType: 'individual' });
  });

  it('assignProfile clears signedAs when a due moves back to Personal', () => {
    const { d, biz } = setup();
    const id = d.commitments[0].id;
    const a = assignProfile(d, id, biz.id, NOW, 'guarantor');
    expect(a.commitments[0]).toMatchObject({ profileId: biz.id, signedAs: 'guarantor' });
    const b = assignProfile(a, id, PERSONAL_PROFILE_ID, NOW);
    expect(b.commitments[0]).toMatchObject({ profileId: PERSONAL_PROFILE_ID, signedAs: null });
  });
});

describe('entitlements', () => {
  const plus: Entitlement = { plan: 'plus', status: 'active', source: 'server' };
  it('Free covers Personal and one business; more need business_profiles (Plus)', () => {
    let d = emptyData();
    expect(canAddBusinessProfile(d, FREE_ENTITLEMENT)).toBe(true);
    d = business(d, 'ACME Traders', 'proprietorship', 'proprietor').data;
    expect(canAddBusinessProfile(d, FREE_ENTITLEMENT)).toBe(false);
    expect(canAddBusinessProfile(d, plus)).toBe(true);
  });
});

describe('moves', () => {
  const move = (kind: Move['kind'], obligationIds: string[]): Move => ({
    id: `${kind}:${obligationIds.join('+')}`,
    kind,
    moduleId: null,
    obligationIds,
    title: 't',
    why: 'w',
    monthlySavingInr: 100,
    rangeInr: [50, 150],
    confidence: 'medium',
    assumptions: [],
    sources: [],
    effort: 'tap',
    action: { url: null, label: '' },
    unverifiedPrice: false,
    legalNote: null,
    sponsored: false,
  });

  it('a move takes its due’s profile; statement-only moves are Personal', () => {
    let d = emptyData();
    const r = business(d, 'ABC Enterprises LLP', 'llp', 'designated_partner', true);
    d = withDue(r.data, 'Office internet', 118000, 'bill', r.profile.id);
    const id = d.commitments[0].id;
    expect(moveProfileId(move('period_switch', [id]), d)).toBe(r.profile.id);
    expect(moveProfileId(move('fee_leak', []), d)).toBe(PERSONAL_PROFILE_ID);
    const [m] = withMoveProfiles([move('period_switch', [id])], d);
    expect(m.profileId).toBe(r.profile.id);
  });

  it('GST line only for a business that did not say it is unregistered, on spending moves', () => {
    let d = withDue(emptyData(), 'Netflix', 64900);
    const personalId = d.commitments[0].id;
    const r = business(d, 'ABC Enterprises LLP', 'llp', 'designated_partner', true);
    d = withDue(r.data, 'Office internet', 118000, 'bill', r.profile.id);
    const bizId = d.commitments[1].id;
    expect(gstNoteFor(move('period_switch', [bizId]), d)).toMatch(/input tax credit/);
    expect(gstNoteFor(move('period_switch', [bizId]), d)).toMatch(/check with your CA/);
    expect(gstNoteFor(move('loan_switch', [bizId]), d)).toBeNull();
    expect(gstNoteFor(move('period_switch', [personalId]), d)).toBeNull();
    const unregistered = updateProfile(d, r.profile.id, { gstRegistered: false });
    expect(gstNoteFor(move('period_switch', [bizId]), unregistered)).toBeNull();
    const notSure = updateProfile(d, r.profile.id, { gstRegistered: null });
    expect(gstNoteFor(move('period_switch', [bizId]), notSure)).not.toBeNull();
  });
});
