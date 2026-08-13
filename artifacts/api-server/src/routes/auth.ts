/**
 * Auth routes
 *
 * GET /api/auth/status — public; returns Clerk session state + Circle membership
 *
 * Authentication is handled by Clerk (clerkMiddleware in app.ts).
 * Authorization is Circle Space Group membership, checked via CIRCLE_API_TOKEN.
 */

import { Router, type IRouter, type Request, type RequestHandler } from "express";
import { getAuth as clerkGetAuth } from "@clerk/express";
import { getUserAuthInfo, checkEmailMembership } from "../lib/circle-membership.js";
import { createRateLimiter } from "../lib/rate-limiter.js";
import { logger } from "../lib/logger.js";

/** Shape expected of any getUserAuthInfo-compatible function. */
type GetUserAuthInfo = (
  userId: string,
) => Promise<{ email: string; authorized: boolean }>;

/** Shape expected of a getAuth-compatible function. */
type GetAuth = (req: Request) => { userId: string | null | undefined };

/** Shape expected of a checkEmailMembership-compatible function. */
type CheckEmailMembership = (email: string) => Promise<boolean>;

/**
 * Production rate limiter for POST /auth/preflight.
 * 10 requests per minute per IP — generous enough that a legitimate user
 * (one submission + a few retries) is never affected, but tight enough
 * to block bulk email-enumeration scripts.
 */
const defaultPreflightLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
});

/**
 * Factory that builds the auth status router with injectable `getUserAuthInfo`,
 * `getAuth`, `checkMembership`, and `preflightLimiter` implementations.
 * Use this in tests to avoid real Clerk / Circle API calls and to control
 * rate-limit behaviour without waiting for real windows to expire.
 *
 * Production code uses the default export below (real Clerk + Circle).
 */
export function createAuthStatusRouter(
  getUserInfo: GetUserAuthInfo = getUserAuthInfo,
  getAuth: GetAuth = clerkGetAuth,
  checkMembership: CheckEmailMembership = checkEmailMembership,
  preflightLimiter: RequestHandler = defaultPreflightLimiter,
): IRouter {
  const router: IRouter = Router();

  // POST /auth/preflight — public; checks Circle membership BEFORE Clerk sends
  // a verification code. Allows the frontend to gate sign-in on Circle access
  // without ever creating a Clerk account for non-members.
  // Rate-limited per IP (default: 10 req/min) to prevent email enumeration.
  router.post("/auth/preflight", preflightLimiter, async (req, res): Promise<void> => {
    const { email } = req.body ?? {};
    if (!email || typeof email !== "string") {
      res.status(400).json({ error: "email required" });
      return;
    }
    try {
      const authorized = await checkMembership(email.trim().toLowerCase());
      res.json({ authorized });
    } catch (err) {
      logger.error({ err }, "Preflight Circle check failed");
      res.status(500).json({ error: "preflight check failed" });
    }
  });

  // GET /auth/status — public, returns current Clerk auth + Circle membership state.
  // Polled by the frontend every few seconds; results are cached in circle-membership.ts.
  router.get("/auth/status", async (req, res): Promise<void> => {
    const { userId } = getAuth(req);

    if (!userId) {
      res.json({
        authenticated: false,
        authorized: false,
        mode: "clerk",
        user: undefined,
      });
      return;
    }

    try {
      const { email, authorized } = await getUserInfo(userId);
      res.json({
        authenticated: true,
        authorized,
        mode: "clerk",
        user: authorized ? { email } : undefined,
      });
    } catch (err) {
      logger.error({ err }, "Auth status check failed");
      res.json({
        authenticated: true,
        authorized: false,
        mode: "clerk",
        user: undefined,
      });
    }
  });

  return router;
}

/** Production auth status router (uses real Clerk + Circle). */
const router = createAuthStatusRouter();
export default router;
