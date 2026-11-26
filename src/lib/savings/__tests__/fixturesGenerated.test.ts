import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('synthetic statement fixtures (M7)', () => {
  it('the committed fixtures are exactly what the generator writes (no hand edits, no real data)', () => {
    const script = join(process.cwd(), 'scripts', 'generate-statement-fixtures.mjs');
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
