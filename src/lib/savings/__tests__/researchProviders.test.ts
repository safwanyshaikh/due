import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MERCHANT_ALIASES } from '../../merchants';
import { canonicalResearchLabel } from '../research';

describe('research labels the server accepts (M6)', () => {
  it('every canonical merchant label the app can send is on the server allowlist', () => {
    const server = new Set<string>(
      JSON.parse(readFileSync(join(process.cwd(), 'server', 'src', 'seed', 'research-providers.json'), 'utf8')),
    );
    for (const m of MERCHANT_ALIASES) {
      const label = canonicalResearchLabel(m.displayName);
      if (label) expect(server.has(label), label).toBe(true);
    }
  });
});
