import { describe, expect, it } from 'vitest';
import { nativeCsp } from '../../../vite.config';

describe('native build CSP (M10)', () => {
  it('allows only the app itself and the Due API origin', () => {
    const csp = nativeCsp('https://due.karigarai.com/');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("connect-src 'self' https://due.karigarai.com");
    expect(csp).toContain("object-src 'none'");
    expect(() => nativeCsp('http://insecure.example')).toThrow(/https/);
  });
});
