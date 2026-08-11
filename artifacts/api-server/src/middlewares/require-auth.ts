/**
 * requireAuth middleware
 *
 * Guards all protected routes. Every endpoint that returns market data,
 * scanner results, or stock details must use this middleware.
 *
 * Authorization flow:
 *   1. Check for a valid server-side session
 *   2. If session exists, revalidate Space Group access (on TTL expiry)
 *   3. If session is missing or revalidation fails, return 401
 *
 * Frontend-side flags (localStorage, URL params, etc.) are NEVER trusted.
 * Only the server-side session determines authorization.
 */

import { type Request, type Response, type NextFunction } from "express";
import { REVALIDATION_TTL_MS } from "../lib/circle-auth.js";
import { circleAuthService } from "../services.js";
import { logger } from "../lib/logger.js";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const session = req.session as any;

  if (!session?.auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const auth = session.auth;
  const now = Date.now();
  const timeSinceRevalidation = now - (auth.lastRevalidatedAt ?? 0);

  // Revalidate Space Group membership if the TTL has expired
  if (timeSinceRevalidation >= REVALIDATION_TTL_MS) {
    req.log.info({ userId: auth.userId }, "Revalidating Space Group access");

    let stillAuthorized = false;
    try {
      stillAuthorized = await circleAuthService.revalidateAccess(auth.userId);
    } catch (err) {
      req.log.error({ err }, "Space Group revalidation failed");
      // Fail closed — deny access on revalidation error
      session.destroy(() => {});
      res.status(401).json({ error: "Authorization check failed. Please log in again." });
      return;
    }

    if (!stillAuthorized) {
      req.log.info({ userId: auth.userId }, "Space Group access revoked — destroying session");
      session.destroy(() => {});
      res.status(401).json({ error: "Access revoked. Please log in again." });
      return;
    }

    // Update revalidation timestamp
    session.auth = { ...auth, lastRevalidatedAt: now };
    logger.debug({ userId: auth.userId }, "Space Group access confirmed");
  }

  next();
}
