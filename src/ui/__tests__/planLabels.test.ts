import { describe, expect, it } from 'vitest';
import { featureLabel } from '../screens/PlansScreen';

describe('plan feature labels', () => {
  it('shows plain language, never raw feature keys', () => {
    const keys = [
      'manual_obligations',
      'upcoming_view',
      'multi_device',
      'reminder_email',
      'verified_evidence',
      'something_new',
    ];
    for (const k of keys) {
      const l = featureLabel(k);
      expect(l).not.toContain('_');
      expect(l).not.toBe(k);
      expect(l[0]).toBe(l[0].toUpperCase());
    }
    expect(featureLabel('multi_device')).toBe('Use on more than one device');
  });
});
