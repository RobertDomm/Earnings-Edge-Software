---
name: External Clerk on Replit — known pitfalls
description: How to wire an external (user-owned) Clerk account into a Replit Vite+Express app without triggering the "Failed to load Clerk JS from clerk.{dev-domain}" error.
---

## Rule
**Never pass `publishableKeyFromHost(getClerkProxyHost(req), ...)` as the `clerkMiddleware` callback on the server when using external Clerk.**
Use `clerkMiddleware()` with no arguments (or plain object) instead.

**Why:** `getClerkProxyHost` returns the raw Replit dev hostname (e.g. `{repl-id}.janeway.replit.dev`). When that string is fed to `publishableKeyFromHost`, the Clerk SDK treats it as a custom FAPI domain and tells the frontend to load `clerk.js` from `https://clerk.{dev-domain}` — a URL that does not exist, causing a hard boot failure.
The no-argument form auto-reads `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from env and constructs the correct FAPI URL from the key itself.

**How to apply:** In `app.ts`, the server middleware line is simply:
```typescript
app.use(clerkMiddleware());
```
The `publishableKeyFromHost` + `getClerkProxyHost` pattern in the skill is only correct for Replit-managed Clerk (where those functions are pre-configured for Replit's own domains).

## Frontend key exposure
Because `CLERK_PUBLISHABLE_KEY` is a server-side secret (not a `VITE_*` var), expose it via Vite's `define` option in `vite.config.ts`:
```typescript
define: {
  'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': JSON.stringify(process.env.CLERK_PUBLISHABLE_KEY ?? ''),
}
```
Then in `App.tsx`, use `import.meta.env.VITE_CLERK_PUBLISHABLE_KEY` directly as the `publishableKey` prop — do NOT wrap it in `publishableKeyFromHost`.

## Auth architecture in this project
- **Authentication**: Clerk (session cookie set by `clerkMiddleware`; checked via `getAuth(req)`)
- **Authorization**: Circle Space Group membership check via `CIRCLE_API_TOKEN`
- **Cache**: `getUserAuthInfo(userId)` in `lib/circle-membership.ts` caches both Clerk email lookup and Circle membership result per userId for 15 minutes. Both `requireAuth` middleware and `/api/auth/status` route use this shared cache.

## Tailwind v4 + Clerk CSS layer
Add `@layer theme, base, clerk, components, utilities;` BEFORE `@import 'tailwindcss'` in `index.css` to prevent Clerk's CSS from overriding Tailwind's utility classes.
Also pass `{ optimize: false }` to the `tailwindcss()` Vite plugin when Clerk is in use.
