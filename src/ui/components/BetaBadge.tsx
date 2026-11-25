import { formatDate } from '../../lib/dates';
import { usePublicStatus } from '../lib/platform';
import { Badge } from './ui';

/** Short label for the free beta, e.g. "Free during beta · until 31 Dec 2026". Null unless the status API says it is on. */
export function betaLabel(beta: { plusFree: boolean; endsOn: string | null }): string {
  return beta.endsOn ? `Free during beta · until ${formatDate(beta.endsOn)}` : 'Free during beta';
}

/** The "Free during beta" badge, driven by GET /api/public/status. Renders nothing while loading, offline or off. */
export function BetaBadge() {
  const st = usePublicStatus();
  if (st.state !== 'ok' || !st.value.beta.plusFree) return null;
  return (
    <span data-testid="beta-badge">
      <Badge tone="premium">{betaLabel(st.value.beta)}</Badge>
    </span>
  );
}
