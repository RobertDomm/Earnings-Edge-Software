/**
 * Auth routes
 *
 * GET /api/auth/status — public; returns Clerk session state + Circle membership
 *
 * Authentication is handled by Clerk (clerkMiddleware in app.ts).
 * Authorization is Circle Space Group membership, checked via CIRCLE_API_TOKEN.
 */

import { Router, type IRouter, type Request } from "express";
import { getAuth as clerkGetAuth } from "@clerk/express";
import { getUserAuthInfo } from "../lib/circle-membership.js";
import { logger } from "../lib/logger.js";

/** Shape expected of any getUserAuthInfo-compatible function. */
type GetUserAuthInfo = (
  userId: string,
) => Promise<{ email: string; authorized: boolean }>;

/** Shape expected of a getAuth-compatible function. */
type GetAuth = (req: Request) => { userId: string | null | undefined };

/**
 * Factory that builds the auth status router with injectable `getUserAuthInfo`
 * and `getAuth` implementations.  Use this in tests to avoid real Clerk /
 * Circle API calls.
 *
 * Production code uses the default export below (real Clerk + Circle).
 */
export function createAuthStatusRouter(
  getUserInfo: GetUserAuthInfo = getUserAuthInfo,
  getAuth: GetAuth = clerkGetAuth,
): IRouter {
  const router: IRouter = Router();

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
