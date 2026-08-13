---
name: Clerk prod instance settings are separate
description: External Clerk keeps Development and Production instance settings independent — auth strategies must be enabled in each.
---

External Clerk instances have fully separate Development and Production configuration. Email-code sign-in working in dev does NOT mean it works in prod.

**Why:** Production sign-in failed with "email_address is not a valid parameter" (422 on /v1/client/sign_ins) even though dev worked — the Production instance had neither the email identifier nor the "Email verification code" authentication strategy enabled.

**How to apply:** When prod-only Clerk 422s appear, check the sign_in attempt's `supported_identifiers` and `supported_first_factors` in the response body (curl the /api/__clerk proxy). Two separate dashboard toggles are needed in the Production instance: (1) Email address identifier with "Email verification code" verification, and (2) "Email verification code" under Authentication strategies. Owner must apply them in dashboard.clerk.com with the env switcher set to Production.
