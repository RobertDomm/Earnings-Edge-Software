/**
 * e2e/auth-redirect.spec.ts
 *
 * Verifies that unauthenticated visitors are redirected to /sign-in before
 * they can view any protected content.
 *
 * Two routes are covered:
 *
 *   /           — the Root page; redirects immediately via useAuth() when
 *                 Clerk is loaded, or after a 5-second timeout when the key
 *                 is rejected (Replit dev domain).
 *
 *   /dashboard  — uses useRequireAuth(); redirects when isLoaded && !isSignedIn.
 *
 * No Clerk session is established in these tests — Playwright starts with a
 * clean browser context so isSignedIn is always false.
 *
 * Run:
 *   pnpm --filter @workspace/screener run test:e2e
 */

import { test, expect } from '@playwright/test';

/** Maximum ms to wait for the redirect to /sign-in to complete.
 *  Root falls back to a 5 s setTimeout when Clerk rejects the dev-domain
 *  key, so allow 8 s total to absorb that and any CI slowness. */
const REDIRECT_TIMEOUT = 8_000;

/** Wait for the page URL to include /sign-in, then assert the email input
 *  is visible — confirming the sign-in page fully rendered, not just that
 *  the URL changed. */
async function expectRedirectedToSignIn(
  page: import('@playwright/test').Page,
) {
  await expect(page).toHaveURL(/\/sign-in/, { timeout: REDIRECT_TIMEOUT });

  await expect(
    page
      .locator('input[type="email"], input[placeholder*="email" i]')
      .first(),
  ).toBeVisible({ timeout: 8_000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Auth redirect — unauthenticated visitor', () => {
  test('visiting / redirects to /sign-in', async ({ page }) => {
    await page.goto('/');
    await expectRedirectedToSignIn(page);
  });

  test('visiting /dashboard redirects to /sign-in', async ({ page }) => {
    await page.goto('/dashboard');
    await expectRedirectedToSignIn(page);
  });
});
