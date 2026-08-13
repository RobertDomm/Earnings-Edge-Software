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
- **200** → member is in the space group → authorized
- **404** → not a member (or email not found in community) → denied
- No `community_id` param needed on this endpoint.
- `CIRCLE_COMMUNITY_ID` env var is NOT used by this endpoint (only needed for the list endpoints).

## Watch out
The response includes `"status": "inactive"` for members who were invited but haven't confirmed. The current implementation treats any 200 as authorized regardless of status — this may let unconfirmed-invite members through. Consider filtering on `status === "active"` if that matters.

## How to apply
See `artifacts/api-server/src/lib/circle-membership.ts` — the `checkCircleMembership` function uses this exact pattern.
