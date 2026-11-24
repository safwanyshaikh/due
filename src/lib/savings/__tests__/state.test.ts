import { describe, expect, it } from 'vitest';
import {
  defaultSavingsState,
  markResearchSent,
  normaliseSavingsState,
  removeCommuteLeg,
  setCityPack,
  setCommunityOptIn,
  setHomeLocality,
  setOverride,
  unsentResearch,
  upsertCommuteLeg,
  researchLabel,
} from '..';
import { emptyData } from '../../data';
import { migrateData } from '../../migrate';
import { parseStored } from '../../storage';

describe('savings state', () => {
  it('defaults', () => {
    expect(defaultSavingsState()).toEqual({
      profile: {
        cityPack: null,
        homeLocality: null,
        commute: [],
        overrides: {},
        communityOptIn: false,
        researchSent: [],
      },
      ledger: [],
    });
    expect(emptyData().savings).toEqual(defaultSavingsState());
  });

  it('profile mutations are pure', () => {
    const s0 = defaultSavingsState();
    let s = setCityPack(s0, 'in-mmr');
    s = setHomeLocality(s, '  Vashi ');
    s = upsertCommuteLeg(s, {
      id: 'a',
      from: 'Vashi',
      to: 'Thane',
      daysPerWeek: 9,
      mode: 'cab',
      costPerTripInr: 400,
    });
    s = upsertCommuteLeg(s, {
      from: 'Thane',
      to: 'Vashi',
      daysPerWeek: 5,
      mode: 'auto',
      costPerTripInr: null,
    });
    expect(s0).toEqual(defaultSavingsState());
    expect(s.profile.cityPack).toBe('in-mmr');
    expect(s.profile.homeLocality).toBe('Vashi');
    expect(s.profile.commute).toHaveLength(2);
    expect(s.profile.commute[0].daysPerWeek).toBe(7);
    expect(s.profile.commute[1].id).toMatch(/^leg_/);
    s = upsertCommuteLeg(s, {
      id: 'a',
      from: 'Vashi',
      to: 'Thane',
      daysPerWeek: 3,
      mode: 'cab',
      costPerTripInr: 350,
    });
    expect(s.profile.commute.find((l) => l.id === 'a')!.daysPerWeek).toBe(3);
    expect(
      upsertCommuteLeg(s, { from: '', to: 'x', daysPerWeek: 1, mode: 'cab', costPerTripInr: null }),
    ).toBe(s);
    s = removeCommuteLeg(s, 'a');
    expect(s.profile.commute.map((l) => l.id)).not.toContain('a');
    s = setOverride(s, 'uber-one-in:ridesPerMonth', 4);
    expect(s.profile.overrides).toEqual({ 'uber-one-in:ridesPerMonth': 4 });
    expect(setOverride(s, 'uber-one-in:ridesPerMonth', null).profile.overrides).toEqual({});
    expect(setCommunityOptIn(s, true).profile.communityOptIn).toBe(true);
  });

  it('research sent tracking', () => {
    const s = markResearchSent(defaultSavingsState(), ['Netflix']);
    const needs = [
      { providerLabel: 'netflix', category: 'ott' as const, obligationIds: ['a'] },
      { providerLabel: 'Acme', category: 'unknown' as const, obligationIds: ['b'] },
    ];
    expect(unsentResearch(needs, s).map((n) => n.providerLabel)).toEqual(['Acme']);
    expect(markResearchSent(s, ['NETFLIX'])).toBe(s);
  });

  it('research labels strip digits, emails and URLs', () => {
    expect(researchLabel('ACME GYM 9876543210')).toBe('ACME GYM');
    expect(researchLabel('a.b@c.com Acme')).toBe('Acme');
    expect(researchLabel('https://acme.example/x Acme Fitness')).toBe('Acme Fitness');
    expect(researchLabel('NETFLIX.COM')).toBe('NETFLIX');
    expect(researchLabel('1234')).toBe('');
    expect(researchLabel('x'.repeat(100)).length).toBe(60);
  });

  it('old data without savings loads with defaults; bad stored values are repaired', () => {
    const old = { ...emptyData() } as Record<string, unknown>;
    delete old.savings;
    const r = parseStored(JSON.stringify(old));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.data.savings).toEqual(defaultSavingsState());
    const messy = migrateData({
      ...emptyData(),
      savings: {
        profile: {
          cityPack: 'in-mmr',
          overrides: { a: 2, b: 'x' },
          commute: [{ id: 'l', from: 'A', to: 'B', daysPerWeek: 5, mode: 'rocket' }, {}],
        },
      },
    } as never);
    expect(messy.savings.profile).toMatchObject({
      cityPack: 'in-mmr',
      overrides: { a: 2 },
      communityOptIn: false,
    });
    expect(messy.savings.profile.commute).toEqual([
      { id: 'l', from: 'A', to: 'B', daysPerWeek: 5, mode: 'cab', costPerTripInr: null },
    ]);
    expect(normaliseSavingsState(null)).toEqual(defaultSavingsState());
  });
});
