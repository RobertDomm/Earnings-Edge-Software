/**
 * requireAuth middleware
 *
 * Guards all protected routes. Verifies:
 *   1. The request carries a valid Clerk session (via clerkMiddleware)
 *   2. The signed-in user's email is in the required Circle Space Group
 *
 * Membership results are cached in circle-membership.ts for 15 minutes.
 */

import { getAuth as clerkGetAuth } from "@clerk/express";
import { type Request, type Response, type NextFunction } from "express";
import { getUserAuthInfo } from "../lib/circle-membership.js";
import { logger } from "../lib/logger.js";

/** Shape expected of any getUserAuthInfo-compatible function. */
type GetUserAuthInfo = (
  userId: string,
) => Promise<{ email: string; authorized: boolean }>;

/** Shape expected of a getAuth-compatible function. */
type GetAuth = (req: Request) => { userId: string | null | undefined };

/**
 * Factory that creates a requireAuth Express middleware with injectable
 * `getUserAuthInfo` and `getAuth` implementations.  Use this in tests to skip
 * real Clerk / Circle API calls.
 *
 * Production code uses `requireAuth` (the pre-built default below).
 */
export function createRequireAuth(
  getUserInfo: GetUserAuthInfo = getUserAuthInfo,
  getAuth: GetAuth = clerkGetAuth,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async function _requireAuth(req, res, next): Promise<void> {
    const { userId } = getAuth(req);

    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const { authorized } = await getUserInfo(userId);
      if (!authorized) {
        res.status(403).json({ error: "Access restricted to community members" });
        return;
      }
      next();
    } catch (err) {
      logger.error({ err }, "Membership check failed");
      res.status(401).json({ error: "Authorization check failed" });
    }
  };
}

/** Production requireAuth middleware (uses real Clerk + Circle). */
export const requireAuth = createRequireAuth();
