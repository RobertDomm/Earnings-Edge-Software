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
 * Checks Circle Space Group membership by email directly.
 * Used by the preflight endpoint to gate sign-in before Clerk sends a code.
 */
export async function checkEmailMembership(
  email: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  return checkCircleMembership(email, fetchImpl);
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
      // The Circle Admin v2 singular endpoint (/space_group_member) returns a
      // single JSON object on 200 when the member exists, e.g. { id: 123, status: "active", ... }.
      // A 404 means not a member.  We require:
      //   - a parseable object with a numeric `id` (confirms the record exists), AND
      //   - `status === "active"` (invited-but-not-joined members have status "inactive"
      //     and must NOT receive app access — only fully joined, active space group
      //     members are authorized).
      const body = await res.json().catch(() => null);
      const record = body as Record<string, unknown> | null;
      if (
        record &&
        typeof record === "object" &&
        !Array.isArray(record) &&
        typeof record.id === "number" &&
        record.status === "active"
      ) {
        logger.debug({ email, spaceGroupId }, "Circle membership confirmed (active member)");
        return true;
      }
      if (record && typeof record.id === "number" && record.status !== "active") {
        logger.debug({ email, spaceGroupId, status: record.status }, "Circle membership denied — member record found but status is not active");
      } else {
        logger.debug({ email, spaceGroupId }, "Circle membership denied — 200 but response was not a valid active member record");
      }
      return false;
    }

    if (res.status === 404) {
      logger.debug({ email, spaceGroupId }, "Circle membership denied — not a space group member");
      return false;
    }

    // Unexpected status — Circle API is misbehaving; surface this as an error
    // so the caller can distinguish from a genuine membership denial.
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, email, body }, "Circle membership check returned unexpected status");
    throw new Error(`Circle API returned unexpected status ${res.status}`);
  } catch (err) {
    // Re-throw so the preflight handler can return 503 instead of treating
    // a Circle outage as a membership denial.
    logger.error({ err, email }, "Circle membership check failed");
    throw err;
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

    // Check Circle Space Group membership (uses the injected fetchImpl).
    // If the Circle API is temporarily unreachable, fail-closed (deny access)
    // rather than propagating the throw — the session auth path must be
    // stable even during a Circle outage.  Only the preflight path
    // (checkEmailMembership → checkCircleMembership) surfaces the throw as
    // a 503 so the UI can show "try again" instead of "not authorized".
    let authorized: boolean;
    try {
      authorized = await checkCircleMembership(email, fetchImpl);
    } catch (err) {
      logger.error({ err, email }, "Circle API unreachable during session auth check — denying access (fail-closed)");
      localCache.set(userId, { email, authorized: false, cachedAt: now });
      return { email, authorized: false };
    }
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
