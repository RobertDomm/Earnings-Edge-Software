/**
 * Circle Space Group membership check with in-memory cache.
 *
 * Uses the Admin v2 Circle API token to verify whether a Clerk user's
 * email belongs to the required Space Group.
 *
 * API:  GET /api/admin/v2/space_group_member?email=X&space_group_id=Y
 *   200 → member found → authorized
 *   404 → member not found → denied
 *
 * Results are cached per Clerk userId for 15 minutes to avoid repeated
 * Circle API calls on every request.
 *
 * Token type required: "Admin v2" (from Circle Developers → Tokens)
 */

import { clerkClient } from "@clerk/express";
import { logger } from "./logger.js";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const CIRCLE_API_BASE = "https://app.circle.so/api/admin/v2";

interface UserAuthCache {
  email: string;
  authorized: boolean;
  cachedAt: number;
}

/** Minimal shape of a Clerk user record used for email resolution. */
export interface ClerkUserRecord {
  primaryEmailAddressId?: string | null;
  emailAddresses: Array<{ id: string; emailAddress: string }>;
}

/**
 * Checks Circle Space Group membership via the Admin v2 API.
 * Accepts an optional `fetchImpl` so tests can inject a mock without
 * mutating the global `fetch` (which would cause inter-suite races).
 */
async function checkCircleMembership(
  email: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const spaceGroupId = process.env.CIRCLE_REQUIRED_SPACE_GROUP_ID;
  const apiToken = process.env.CIRCLE_API_TOKEN;

  if (!spaceGroupId || !apiToken) {
    logger.warn("CIRCLE_REQUIRED_SPACE_GROUP_ID or CIRCLE_API_TOKEN missing — denying access");
    return false;
  }

  const url =
    `${CIRCLE_API_BASE}/space_group_member` +
    `?email=${encodeURIComponent(email)}` +
    `&space_group_id=${encodeURIComponent(spaceGroupId)}`;

  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Token ${apiToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 200) {
      // The Circle Admin v2 API returns an array of member records on 200.
      // A non-empty array = member found; an empty array = not a member.
      // We parse the body and only authorize when we see at least one record,
      // so a 200 with [] is treated as non-member (fail-closed).
      const body = await res.json().catch(() => null);
      if (Array.isArray(body) && body.length > 0) {
        logger.debug({ email, spaceGroupId }, "Circle membership confirmed");
        return true;
      }
      logger.debug({ email, spaceGroupId }, "Circle membership denied — 200 but no member records returned");
      return false;
    }

    if (res.status === 404) {
      logger.debug({ email, spaceGroupId }, "Circle membership denied — not a space group member");
      return false;
    }

    // Unexpected status — fail closed
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, email, body }, "Circle membership check returned unexpected status — denying");
    return false;
  } catch (err) {
    logger.error({ err, email }, "Circle membership check threw — denying");
    return false;
  }
}

/**
 * Factory that builds a getUserAuthInfo function with injectable dependencies:
 *   - `getClerkUser`: resolves a Clerk userId → user record (email, etc.)
 *   - `fetchImpl`: used for Circle API calls (injectable for tests to avoid
 *     mutating globalThis.fetch across concurrent suites)
 *
 * Production code uses the pre-built `getUserAuthInfo` export below.
 */
export function createGetUserAuthInfo(
  getClerkUser: GetClerkUser,
  fetchImpl: typeof fetch = globalThis.fetch,
): (userId: string) => Promise<{ email: string; authorized: boolean }> {
  const localCache = new Map<string, UserAuthCache>();

  return async function _getUserAuthInfo(
    userId: string,
  ): Promise<{ email: string; authorized: boolean }> {
    const now = Date.now();
    const cached = localCache.get(userId);
    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
      return { email: cached.email, authorized: cached.authorized };
    }

    // Fetch email from Clerk
    let email = "";
    try {
      const user = await getClerkUser(userId);
      email =
        user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
          ?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "";
    } catch (err) {
      logger.error({ err, userId }, "Failed to fetch Clerk user");
      return { email: "", authorized: false };
    }

    if (!email) {
      localCache.set(userId, { email: "", authorized: false, cachedAt: now });
      return { email: "", authorized: false };
    }

    // Check Circle Space Group membership (uses the injected fetchImpl)
    const authorized = await checkCircleMembership(email, fetchImpl);
    localCache.set(userId, { email, authorized, cachedAt: now });
    return { email, authorized };
  };
}

/** Fetches a Clerk user by ID.  Injectable for tests. */
export type GetClerkUser = (userId: string) => Promise<ClerkUserRecord>;

/**
 * Returns the email and Circle membership status for a Clerk userId.
 * Cached for CACHE_TTL_MS — call this from both requireAuth and the
 * status endpoint so they agree without duplicate Clerk API calls.
 *
 * Uses the real Clerk client.  For tests, use `createGetUserAuthInfo`.
 */
export const getUserAuthInfo = createGetUserAuthInfo(
  (userId) => clerkClient.users.getUser(userId) as Promise<ClerkUserRecord>,
);
