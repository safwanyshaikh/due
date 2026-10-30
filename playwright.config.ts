import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * E2E runs against the production build served by `vite preview`. The browser is the one
 * preinstalled for @playwright/test (PLAYWRIGHT_BROWSERS_PATH); set PW_CHROMIUM_PATH to use a
 * specific Chromium binary (e.g. /opt/pw-browsers/chromium) if the versions ever drift apart.
 */
const executablePath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 45_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:4173',
    launchOptions: executablePath && existsSync(executablePath) ? { executablePath } : {},
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
