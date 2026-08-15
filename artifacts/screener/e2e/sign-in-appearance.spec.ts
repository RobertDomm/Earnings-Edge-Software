/**
 * e2e/sign-in-appearance.spec.ts
 *
 * Playwright tests for the sign-in page appearance guarantees:
 *
 *   1. No "Sign up" / "Don't have an account" text is visible — the custom
 *      sign-in page intentionally omits sign-up affordances because access is
 *      gated by Circle community membership.
 *
 *   2. The sign-in flow still works — the email input renders and accepts input,
 *      and the submit button is present.
 *
 * The page is a fully custom React form (using Clerk hooks directly), not the
 * hosted Clerk SignIn widget.  There is no cross-origin iframe to enter.
 *
 * Run:
 *   pnpm --filter @workspace/screener run test:e2e
 */

import { test, expect } from '@playwright/test';

// How long to wait for the sign-in page to become interactive.
const PAGE_TIMEOUT = 15_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Navigate to /sign-in and wait until the email input is visible.
 */
async function goToSignIn(page: import('@playwright/test').Page) {
  await page.goto('/sign-in');
  await page
    .locator('input[type="email"], input[placeholder*="email" i]')
    .first()
    .waitFor({ state: 'visible', timeout: PAGE_TIMEOUT });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Sign-in page — sign-up link removed', () => {
  test('no "Sign up" or "Don\'t have an account" text is visible', async ({
    page,
  }) => {
    await goToSignIn(page);

    // None of these phrases should be present anywhere on the page.
    const signUpTextMatchers = [
      /sign up/i,
      /don't have an account/i,
      /create (an? )?account/i,
    ];

    for (const pattern of signUpTextMatchers) {
      const match = page.getByText(pattern);
      // Must not be visible — either absent or hidden.
      const visible = await match.isVisible().catch(() => false);
      expect(visible, `"${pattern}" should not be visible`).toBe(false);
    }
  });
});

test.describe('Sign-in page — sign-in flow still works', () => {
  test('email input is present and accepts input', async ({ page }) => {
    await goToSignIn(page);

    // Confirm the email field is rendered and interactive.
    const emailInput = page.locator(
      'input[type="email"], input[placeholder*="email" i]',
    ).first();
    await expect(emailInput).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Type a dummy value and read it back.
    const testEmail = 'playwright-test@example.com';
    await emailInput.fill(testEmail);
    await expect(emailInput).toHaveValue(testEmail);

    // Confirm the Continue / Submit button is present.
    const continueBtn = page
      .getByRole('button', { name: /continue|sign in|next/i })
      .first();
    await expect(continueBtn).toBeVisible({ timeout: 5_000 });
  });
});
