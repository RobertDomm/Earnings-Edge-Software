# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sign-in-appearance.spec.ts >> Sign-in page — sign-up link removed >> no "Sign up" or "Don't have an account" text is visible
- Location: e2e/sign-in-appearance.spec.ts:46:3

# Error details

```
Error: page.waitForSelector: Target crashed 
Call log:
  - waiting for locator('iframe[title="Sign in"]') to be visible

```

# Test source

```ts
  1   | /**
  2   |  * e2e/sign-in-appearance.spec.ts
  3   |  *
  4   |  * Playwright tests for the SignIn page appearance changes:
  5   |  *
  6   |  *   1. The "Sign up / Don't have an account" footer action is absent — confirming
  7   |  *      `appearance={{ elements: { footerAction: { display: 'none' } } }}` works.
  8   |  *
  9   |  *   2. The sign-in flow itself still works — the Clerk SignIn component renders a
  10  |  *      functional email input that accepts user input.
  11  |  *
  12  |  * Clerk renders its hosted UI inside an iframe.  Both tests enter that iframe
  13  |  * via `page.frameLocator` before making assertions.
  14  |  *
  15  |  * Run:
  16  |  *   pnpm --filter @workspace/screener run test:e2e
  17  |  */
  18  | 
  19  | import { test, expect } from '@playwright/test';
  20  | 
  21  | // Clerk's embedded SignIn widget is rendered inside a cross-origin iframe.
  22  | // The iframe's title is reliably set to "Sign in" by Clerk.
  23  | const CLERK_FRAME = 'iframe[title="Sign in"]';
  24  | 
  25  | // How long to wait for the Clerk iframe to appear and its content to load.
  26  | const CLERK_TIMEOUT = 30_000;
  27  | 
  28  | // ── Helpers ───────────────────────────────────────────────────────────────────
  29  | 
  30  | /**
  31  |  * Navigate to /sign-in and wait until the Clerk iframe is present in the DOM.
  32  |  * Returns the FrameLocator for further assertions.
  33  |  */
  34  | async function goToSignIn(page: import('@playwright/test').Page) {
  35  |   await page.goto('/sign-in');
  36  | 
  37  |   // Wait for the Clerk iframe to appear.
> 38  |   await page.waitForSelector(CLERK_FRAME, { timeout: CLERK_TIMEOUT });
      |              ^ Error: page.waitForSelector: Target crashed 
  39  | 
  40  |   return page.frameLocator(CLERK_FRAME);
  41  | }
  42  | 
  43  | // ── Tests ─────────────────────────────────────────────────────────────────────
  44  | 
  45  | test.describe('Sign-in page — sign-up link removed', () => {
  46  |   test('no "Sign up" or "Don\'t have an account" text is visible', async ({
  47  |     page,
  48  |   }) => {
  49  |     const clerk = await goToSignIn(page);
  50  | 
  51  |     // Wait for the sign-in card body to be rendered inside the Clerk iframe.
  52  |     await clerk
  53  |       .locator('[data-localization-key], input[name="identifier"]')
  54  |       .first()
  55  |       .waitFor({ timeout: CLERK_TIMEOUT });
  56  | 
  57  |     // The footerAction element should not contain visible text matching
  58  |     // "Sign up" or the prompt phrase Clerk typically shows.
  59  |     const signUpTextMatchers = [
  60  |       /sign up/i,
  61  |       /don't have an account/i,
  62  |       /create (an? )?account/i,
  63  |     ];
  64  | 
  65  |     for (const pattern of signUpTextMatchers) {
  66  |       // Look inside the Clerk iframe for any element whose text matches.
  67  |       const match = clerk.getByText(pattern);
  68  | 
  69  |       // The element must not be visible — either absent from the DOM or
  70  |       // hidden by the display:none applied via the appearance prop.
  71  |       await expect(match).not.toBeVisible({ timeout: 5_000 }).catch(() => {
  72  |         // getByText throws when nothing matches — that's a pass.
  73  |       });
  74  |     }
  75  | 
  76  |     // Extra guard: the outer page itself also must not show these strings.
  77  |     // (In case Clerk ever renders outside the iframe in a future version.)
  78  |     await expect(page.getByText(/sign up/i)).not.toBeVisible();
  79  |     await expect(page.getByText(/don't have an account/i)).not.toBeVisible();
  80  |   });
  81  | });
  82  | 
  83  | test.describe('Sign-in page — sign-in flow still works', () => {
  84  |   test('email input is present and accepts input', async ({ page }) => {
  85  |     const clerk = await goToSignIn(page);
  86  | 
  87  |     // Confirm the identifier (email / username) field rendered.
  88  |     const emailInput = clerk.locator('input[name="identifier"]');
  89  |     await expect(emailInput).toBeVisible({ timeout: CLERK_TIMEOUT });
  90  | 
  91  |     // Confirm the field is interactive — type a dummy value and read it back.
  92  |     const testEmail = 'playwright-test@example.com';
  93  |     await emailInput.fill(testEmail);
  94  |     await expect(emailInput).toHaveValue(testEmail);
  95  | 
  96  |     // Confirm the Continue / Sign-in submit button is present.
  97  |     const continueBtn = clerk
  98  |       .getByRole('button', { name: /continue|sign in|next/i })
  99  |       .first();
  100 |     await expect(continueBtn).toBeVisible({ timeout: 5_000 });
  101 |   });
  102 | });
  103 | 
```