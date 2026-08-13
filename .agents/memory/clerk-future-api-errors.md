---
name: Clerk v6 Future API error handling
description: Future API methods resolve to { error }, never throw — try/catch silently misses failures
---

# Clerk v6 Future API error handling

All Clerk v6 Future API methods (`signIn.emailCode.sendCode/verifyCode`, `signIn.finalize`, `signUp.create`, `signUp.verifications.sendEmailCode/verifyEmailCode`, `signUp.finalize`, etc.) resolve to `{ error: ClerkError | null }` and **never throw** on API errors.

**Error shape trap:** API failures are `ClerkAPIResponseError` instances whose top-level `code` is ALWAYS the generic `"api_response_error"`. The specific machine-stable code (e.g. `form_identifier_not_found`) and the user-displayable `longMessage` are nested in `error.errors[].code` / `error.errors[].longMessage`. Matching against top-level `error.code` never fires for API errors — collect codes from both levels.

**Why:** Wrapping these calls in try/catch silently swallows failures — the sign-in form advanced to the code step with no email sent, and the new-user sign-up fallback (which keyed off a caught `errors[0].code`) never fired. Production symptom: 422 on `POST /v1/client/sign_ins` with no follow-up `sign_ups` request.

**How to apply:** Always destructure `const { error } = await ...` and branch on it; only use try/catch for genuine network/runtime failures. Types live in `@clerk/shared/dist/types/signInFuture.d.mts` / `signUpFuture.d.mts`.
