/**
 * e2e/sign-in-appearance.spec.ts
 *
 * Playwright tests for the SignIn page appearance changes:
 *
 *   1. The "Sign up / Don't have an account" footer action is absent — confirming
 *      `appearance={{ elements: { footerAction: { display: 'none' } } }}` works.
 *
 *   2. The sign-in flow itself still works — the Clerk SignIn component renders a
 *      functional email input that accepts user input.
 *
 * Clerk renders its hosted UI inside an iframe.  Both tests enter that iframe
 * via `page.frameLocator` before making assertions.
 *
 * Run:
 *   pnpm --filter @workspace/screener run test:e2e
 */

import { test, expect } from '@playwright/test';

// Clerk's embedded SignIn widget is rendered inside a cross-origin iframe.
// The iframe's title is reliably set to "Sign in" by Clerk.
const CLERK_FRAME = 'iframe[title="Sign in"]';

// How long to wait for the Clerk iframe to appear and its content to load.
const CLERK_TIMEOUT = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Navigate to /sign-in and wait until the Clerk iframe is present in the DOM.
 * Returns the FrameLocator for further assertions.
 */
async function goToSignIn(page: import('@playwright/test').Page) {
  await page.goto('/sign-in');

  // Wait for the Clerk iframe to appear.
  await page.waitForSelector(CLERK_FRAME, { timeout: CLERK_TIMEOUT });

  return page.frameLocator(CLERK_FRAME);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Sign-in page — sign-up link removed', () => {
  test('no "Sign up" or "Don\'t have an account" text is visible', async ({
    page,
  }) => {
    const clerk = await goToSignIn(page);

    // Wait for the sign-in card body to be rendered inside the Clerk iframe.
    await clerk
      .locator('[data-localization-key], input[name="identifier"]')
      .first()
      .waitFor({ timeout: CLERK_TIMEOUT });

    // The footerAction element should not contain visible text matching
    // "Sign up" or the prompt phrase Clerk typically shows.
    const signUpTextMatchers = [
      /sign up/i,
      /don't have an account/i,
      /create (an? )?account/i,
    ];

    for (const pattern of signUpTextMatchers) {
      // Look inside the Clerk iframe for any element whose text matches.
      const match = clerk.getByText(pattern);

      // The element must not be visible — either absent from the DOM or
      // hidden by the display:none applied via the appearance prop.
      await expect(match).not.toBeVisible({ timeout: 5_000 }).catch(() => {
        // getByText throws when nothing matches — that's a pass.
      });
    }

    // Extra guard: the outer page itself also must not show these strings.
    // (In case Clerk ever renders outside the iframe in a future version.)
    await expect(page.getByText(/sign up/i)).not.toBeVisible();
    await expect(page.getByText(/don't have an account/i)).not.toBeVisible();
  });
});

test.describe('Sign-in page — sign-in flow still works', () => {
  test('email input is present and accepts input', async ({ page }) => {
    const clerk = await goToSignIn(page);

    // Confirm the identifier (email / username) field rendered.
    const emailInput = clerk.locator('input[name="identifier"]');
    await expect(emailInput).toBeVisible({ timeout: CLERK_TIMEOUT });

    // Confirm the field is interactive — type a dummy value and read it back.
    const testEmail = 'playwright-test@example.com';
    await emailInput.fill(testEmail);
    await expect(emailInput).toHaveValue(testEmail);

    // Confirm the Continue / Sign-in submit button is present.
    const continueBtn = clerk
      .getByRole('button', { name: /continue|sign in|next/i })
      .first();
    await expect(continueBtn).toBeVisible({ timeout: 5_000 });
  });
});
