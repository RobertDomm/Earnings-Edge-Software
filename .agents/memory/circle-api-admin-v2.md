---
name: Circle Admin v2 API — correct endpoint for space group membership check
description: The only working endpoint for server-side Circle Space Group membership checks, including auth format, token type, and response handling.
---

## Rule
**Use `GET https://app.circle.so/api/admin/v2/space_group_member?email=X&space_group_id=Y` for membership checks.**

The old `/api/v1/space_group_members` (plural, with community_id) returns 404 HTML. The correct base is `/api/admin/v2/`, not `/api/v1/`.

**Why:** Circle has two completely separate API tiers. The v1 API (`/api/v1/`) requires a different credential type that isn't available from the Developer → Tokens UI. The Admin v2 API (`/api/admin/v2/`) is what the "Admin v2" community token type (generated in Community → Developers → Tokens) works with.

## Token type
Must be **"Admin v2"** generated from Circle → (gear icon) → Developers → Tokens → New token → Type: Admin v2.
- NOT "Zapier", "Admin v1", or "Headless Auth" — those hit different APIs.
- Auth header: `Authorization: Token <token_value>`
- Stored as `CIRCLE_API_TOKEN` secret.

## Correct endpoint
```
GET https://app.circle.so/api/admin/v2/space_group_member
  ?email=<url-encoded email>
  &space_group_id=<CIRCLE_REQUIRED_SPACE_GROUP_ID>
Authorization: Token <CIRCLE_API_TOKEN>
```
- **200** → returns a **single JSON object** (not an array) with numeric `id`, e.g. `{ id: 123, user_id: ..., space_group_id: ..., status: "active", ... }` → authorized only if `typeof body.id === "number"` AND `body.status === "active"`
- **404** → not a member (or email not found in community) → denied
- No `community_id` param needed on this endpoint.
- `CIRCLE_COMMUNITY_ID` env var is NOT used by this endpoint (only needed for the list endpoints).

**Why this matters:** The plural endpoint (`/space_group_members`) returns a paginated array and ignores the `email` filter — do NOT use it for membership checks. The singular endpoint returns one object; checking `Array.isArray(body)` always returns false and will deny every real member.

## Product rule (revised Aug 2026 — deny-list, not allow-list)
App access requires membership in the space group configured in `CIRCLE_REQUIRED_SPACE_GROUP_ID` (owner's group: 226885). Any member record (200 + numeric `id`) is authorized UNLESS its status (case-insensitive) is in the blocked set: banned, suspended, removed, deactivated, deleted, blocked. **`status: "inactive"` is ALLOWED** — Circle marks added-but-unconfirmed members "inactive", including the owner's own record; requiring `status === "active"` locked the owner out of production. Missing/unknown statuses are allowed; 404 stays denied; Circle outages throw → preflight 503.

## How to apply
See `artifacts/api-server/src/lib/circle-membership.ts` — the `checkCircleMembership` function uses this exact pattern.
