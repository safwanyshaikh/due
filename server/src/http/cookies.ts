/**
 * Cookie names. In production every session cookie uses the `__Host-` prefix: the browser then only accepts it
 * when it is Secure, has Path=/ and no Domain, so a sibling subdomain cannot plant or overwrite it.
 * Older cookies (without the prefix) are simply ignored, so people sign in again once after the change.
 */
export type CookieBase = 'due_session' | 'due_acct' | 'due_intake';

export function cookieName(base: CookieBase, isProduction: boolean): string {
  return isProduction ? `__Host-${base}` : base;
}
