/**
 * requireAuth middleware
 *
 * Guards all protected routes. Verifies:
 *   1. The request carries a valid Clerk session (via clerkMiddleware)
 *   2. The signed-in user's email is in the required Circle Space Group
 *
 * Membership results are cached in circle-membership.ts for 15 minutes.
 */

import { getAuth } from "@clerk/express";
import { type Request, type Response, type NextFunction } from "express";
import { getUserAuthInfo } from "../lib/circle-membership.js";
import { logger } from "../lib/logger.js";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { userId } = getAuth(req);

  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const { authorized } = await getUserAuthInfo(userId);
    if (!authorized) {
      res.status(403).json({ error: "Access restricted to community members" });
      return;
    }
    next();
  } catch (err) {
    logger.error({ err }, "Membership check failed");
    res.status(401).json({ error: "Authorization check failed" });
  }
}
