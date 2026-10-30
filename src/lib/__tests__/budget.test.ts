import { describe, expect, it } from 'vitest';
import { evaluateCap } from '../budget';
import {
  canOfferReview,
  overCapMessage,
  ESSENTIAL_NOTE,
  REVIEW_ACTIONS,
  COOLING_OFF_NOTE,
} from '../review';
import { statusLabel } from '../status';

describe('caps', () => {
  const T = [80, 100];
  it('transitions at 80%, 100% and above', () => {
    expect(evaluateCap(7999, 10000, T).level).toBe('ok');
    expect(evaluateCap(8000, 10000, T).level).toBe('approaching');
    expect(evaluateCap(9999, 10000, T).level).toBe('approaching');
    expect(evaluateCap(10000, 10000, T).level).toBe('at_cap');
    expect(evaluateCap(10001, 10000, T).level).toBe('over');
  });
  it('is off when disabled or no cap', () => {
    expect(evaluateCap(5, null, T).level).toBe('off');
    expect(evaluateCap(5, 100, T, false).level).toBe('off');
  });
  it('supports custom thresholds', () => {
    expect(evaluateCap(5000, 10000, [50, 100]).level).toBe('approaching');
  });
});

describe('review rules and wording', () => {
  it('only optional subscriptions can be offered review', () => {
    expect(canOfferReview({ type: 'subscription', importance: 'optional' })).toBe(true);
    expect(canOfferReview({ type: 'subscription', importance: 'essential' })).toBe(false);
    for (const t of ['emi', 'other_loan', 'credit_card', 'school_fee', 'bill', 'other'] as const) {
      expect(canOfferReview({ type: t, importance: 'optional' })).toBe(false);
    }
  });
  it('copy never tells users to skip, delay, cancel essentials or to pay now', () => {
    const all = [
      overCapMessage('₹10', '₹5', true),
      ESSENTIAL_NOTE,
      COOLING_OFF_NOTE,
      ...REVIEW_ACTIONS,
    ].join(' ');
    expect(all).not.toMatch(/\b(skip|waste|wasting|pay now|act now|disaster)\b/i);
    expect(ESSENTIAL_NOTE).not.toMatch(/cancel|delay|skip/i);
    expect(REVIEW_ACTIONS.join(' ')).not.toMatch(/cancel|pause/i);
    expect(overCapMessage('₹10', '₹5', false)).toContain('limit you chose');
  });
  it('planned states are never labelled as confirmed', () => {
    expect(statusLabel('pause_planned')).not.toMatch(/confirmed/i);
    expect(statusLabel('cancel_pending')).toMatch(/not confirmed/i);
    expect(statusLabel('pause_confirmed_by_user')).toMatch(/you/i);
  });
});
