/**
 * Playwright configuration for the screener artifact.
 *
 * Tests run against the already-running Vite dev server (port 20427).
 * If the server isn't up, Playwright's webServer block will start it.
 *
 * Run locally / CI:
 *   pnpm --filter @workspace/screener run test:e2e
 *
 * On Replit the Vite dev server is already managed by the `artifacts/screener: web`
 * workflow, so `reuseExistingServer: true` avoids starting a second copy.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',

  use: {
    baseURL: 'http://localhost:20427',
    trace: 'on-first-retry',
    launchOptions: {
      // Disable GPU acceleration — required in the Replit sandbox where the
      // system Mesa package does not expose libgbm.so.1.
      args: ['--disable-gpu', '--no-sandbox'],
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command:
      'PORT=20427 BASE_PATH=/ pnpm --filter @workspace/screener run dev',
    url: 'http://localhost:20427',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
