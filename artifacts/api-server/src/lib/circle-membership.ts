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

const cache = new Map<string, UserAuthCache>();

/**
 * Returns the email and Circle membership status for a Clerk userId.
 * Cached for CACHE_TTL_MS — shared between requireAuth middleware and
 * the /auth/status route so they agree without duplicate Clerk/Circle calls.
 */
export async function getUserAuthInfo(
  userId: string
): Promise<{ email: string; authorized: boolean }> {
  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return { email: cached.email, authorized: cached.authorized };
  }

  // Fetch primary email from Clerk
  let email = "";
  try {
    const user = await clerkClient.users.getUser(userId);
    email =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
        ?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "";
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch Clerk user");
    return { email: "", authorized: false };
  }

  if (!email) {
    cache.set(userId, { email: "", authorized: false, cachedAt: now });
    return { email: "", authorized: false };
  }

  // Check Circle Space Group membership
  const authorized = await checkCircleMembership(email);
  cache.set(userId, { email, authorized, cachedAt: now });
  return { email, authorized };
}

async function checkCircleMembership(email: string): Promise<boolean> {
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
    const res = await fetch(url, {
      headers: {
        Authorization: `Token ${apiToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 200) {
      logger.debug({ email, spaceGroupId }, "Circle membership confirmed");
      return true;
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
