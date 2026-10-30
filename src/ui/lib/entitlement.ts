import type { Entitlements, Feature as ServerFeature } from '../../lib/account/types';
import { FREE_ENTITLEMENT, type Entitlement } from '../../lib/plans';

/** Maps the server's entitlement record to the domain mirror used for display-only checks. */
export function toDomainEntitlement(e: Entitlements | null | undefined): Entitlement {
  if (!e) return FREE_ENTITLEMENT;
  return {
    plan: e.plan,
    status: e.status === 'expired' ? 'expired' : 'active',
    validUntil: e.periodEnd,
    source: 'server',
  };
}

/** Server-side gate: true only when the server reports the feature for this account. */
export function serverAllows(e: Entitlements | null | undefined, f: ServerFeature): boolean {
  return !!e && e.status !== 'expired' && e.features.includes(f);
}
