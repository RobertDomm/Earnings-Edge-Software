/**
 * Circle Space Group membership check with in-memory cache.
 *
 * Uses the CIRCLE_API_TOKEN to verify whether a given Clerk user
 * (looked up by userId) has access to the required Space Group.
 * Results are cached per userId for 15 minutes to avoid hammering
 * the Circle API on every request.
 */

import { clerkClient } from "@clerk/express";
import { logger } from "./logger.js";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface UserAuthCache {
  email: string;
  authorized: boolean;
  cachedAt: number;
}

const cache = new Map<string, UserAuthCache>();

/**
 * Returns the email and Circle membership status for a Clerk userId.
 * Cached for CACHE_TTL_MS — call this from both requireAuth and the
 * status endpoint so they agree without duplicate Clerk API calls.
 */
export async function getUserAuthInfo(
  userId: string
): Promise<{ email: string; authorized: boolean }> {
  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return { email: cached.email, authorized: cached.authorized };
  }

  // Fetch email from Clerk
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
  const communityId = process.env.CIRCLE_COMMUNITY_ID;
  const spaceGroupId = process.env.CIRCLE_REQUIRED_SPACE_GROUP_ID;
  const apiToken = process.env.CIRCLE_API_TOKEN;

  if (!communityId || !spaceGroupId || !apiToken) {
    logger.warn("Circle membership env vars missing — denying access");
    return false;
  }

  try {
    const url =
      `https://app.circle.so/api/v1/space_group_members` +
      `?community_id=${encodeURIComponent(communityId)}` +
      `&space_group_id=${encodeURIComponent(spaceGroupId)}` +
      `&email=${encodeURIComponent(email)}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Token ${apiToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 404) return false;
    if (!res.ok) {
      logger.warn({ status: res.status, email }, "Circle membership check failed — denying");
      return false;
    }

    const data = (await res.json()) as any;
    if (Array.isArray(data)) return data.length > 0;
    if ("records" in data) return (data.records?.length ?? 0) > 0;
    if ("email" in data) return true;
    return false;
  } catch (err) {
    logger.error({ err, email }, "Circle membership check threw");
    return false;
  }
}
