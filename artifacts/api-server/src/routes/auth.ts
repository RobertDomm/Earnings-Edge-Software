/**
 * Auth routes
 *
 * GET /api/auth/status — public; returns Clerk session state + Circle membership
 *
 * Authentication is handled by Clerk (clerkMiddleware in app.ts).
 * Authorization is Circle Space Group membership, checked via CIRCLE_API_TOKEN.
 */

import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { getUserAuthInfo } from "../lib/circle-membership.js";
import { logger } from "../lib/logger.js";

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
    const { email, authorized } = await getUserAuthInfo(userId);
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

export default router;
