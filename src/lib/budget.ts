import type { Budget } from './types';

export type CapLevel = 'off' | 'ok' | 'approaching' | 'at_cap' | 'over';

export interface CapResult {
  level: CapLevel;
  percent: number;
  crossed: number[];
}

export const DEFAULT_BUDGET: Budget = {
  enabled: false,
  overallMonthlyCapPaise: null,
  discretionaryMonthlyCapPaise: null,
  thresholds: [80, 100],
};

/** Integer-safe comparison: value * 100 >= cap * threshold. */
export function evaluateCap(
  valuePaise: number,
  capPaise: number | null,
  thresholds: number[],
  enabled = true,
): CapResult {
  if (!enabled || capPaise === null || capPaise <= 0)
    return { level: 'off', percent: 0, crossed: [] };
  const percent = (valuePaise / capPaise) * 100;
  const crossed = [...new Set(thresholds)]
    .filter((t) => t > 0 && valuePaise * 100 >= capPaise * t)
    .sort((a, b) => a - b);
  if (valuePaise > capPaise) return { level: 'over', percent, crossed };
  if (valuePaise === capPaise || crossed.includes(100))
    return { level: 'at_cap', percent, crossed };
  if (crossed.length > 0) return { level: 'approaching', percent, crossed };
  return { level: 'ok', percent, crossed };
}
