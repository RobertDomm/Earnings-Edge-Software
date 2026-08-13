/**
 * Auth routes
 *
 * POST /api/auth/logout       — destroy session
 * GET  /api/auth/status       — return current session auth state
 * GET  /api/auth/login        — initiate Circle OAuth (or mock flow)
 * GET  /api/auth/callback     — OAuth callback; verify Space Group; create session
 */

import { Router, type IRouter } from "express";
import { circleAuthService } from "../services.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// GET /auth/status — public, returns current session state
router.get("/auth/status", async (req, res): Promise<void> => {
  const session = req.session as any;
  const auth = session?.auth;

  if (!auth) {
    res.json({
      authenticated: false,
      authorized: false,
      mode: circleAuthService.mode,
      user: undefined,
      loginUrl: circleAuthService.getLoginUrl(),
    });
    return;
  }

  res.json({
    authenticated: true,
    authorized: true,
    mode: circleAuthService.mode,
    user: auth.user,
    loginUrl: null,
  });
});

// GET /auth/login — public, starts login flow
router.get("/auth/login", async (req, res): Promise<void> => {
  const session = req.session as any;

  if (circleAuthService.mode === "mock") {
    // Mock mode: accept a ?scenario= param for testing
    const scenario =
      typeof req.query.scenario === "string"
        ? req.query.scenario
        : "anonymous";

    const result = await circleAuthService.validateAuthCode(scenario);

    if (result.authorized && result.user) {
      session.auth = {
        userId: result.user.id,
        user: result.user,
        authorizedAt: Date.now(),
        lastRevalidatedAt: Date.now(),
      };

      req.log.info({ userId: result.user.id, scenario }, "Mock login succeeded");

      // If request accepts JSON (API client), return JSON
      if (req.headers.accept?.includes("application/json")) {
        res.json({
          authenticated: true,
          authorized: true,
          mode: "mock",
          user: result.user,
          loginUrl: null,
        });
      } else {
        res.redirect("/");
      }
      return;
    }

    // Not authorized in mock mode
    req.log.info({ scenario }, "Mock login: access denied");
    if (req.headers.accept?.includes("application/json")) {
      res.json({
        authenticated: result.authenticated,
        authorized: false,
        mode: "mock",
        user: result.user ?? undefined,
        loginUrl: circleAuthService.getLoginUrl(),
      });
    } else {
      res.redirect("/access-restricted");
    }
    return;
  }

  // Live mode: redirect to Circle OAuth
  const callbackUrl = `${req.protocol}://${req.get("host")}/api/auth/callback`;
  const loginUrl = circleAuthService.getLoginUrl(callbackUrl);
  res.redirect(loginUrl);
});

// GET /auth/callback — OAuth callback handler
router.get("/auth/callback", async (req, res): Promise<void> => {
  const session = req.session as any;
  const code = typeof req.query.code === "string" ? req.query.code : "";

  // Reconstruct the exact redirect_uri used during the authorize step —
  // Circle requires it to match in the token exchange.
  const redirectUri = `${req.protocol}://${req.get("host")}/api/auth/callback`;

  let result;
  try {
    result = await circleAuthService.validateAuthCode(code, redirectUri);
  } catch (err) {
    // Log full error server-side; never expose it to the client
    logger.error({ err }, "Auth callback validation failed");
    res.redirect("/access-restricted");
    return;
  }

  if (result.authorized && result.user) {
    session.auth = {
      userId: result.user.id,
      user: result.user,
      authorizedAt: Date.now(),
      lastRevalidatedAt: Date.now(),
    };
    req.log.info({ userId: result.user.id }, "Session created after auth callback");

    if (req.headers.accept?.includes("application/json")) {
      res.json({
        authenticated: true,
        authorized: true,
        mode: circleAuthService.mode,
        user: result.user,
        loginUrl: null,
      });
    } else {
      res.redirect("/dashboard");
    }
    return;
  }

  req.log.info(
    { authenticated: result.authenticated, authorized: result.authorized },
    "Auth callback: access denied"
  );

  if (req.headers.accept?.includes("application/json")) {
    res.json({
      authenticated: result.authenticated,
      authorized: false,
      mode: circleAuthService.mode,
      user: undefined,
      loginUrl: circleAuthService.getLoginUrl(),
    });
  } else {
    res.redirect("/access-restricted");
  }
});

// POST /auth/logout — destroy session
router.post("/auth/logout", async (req, res): Promise<void> => {
  const session = req.session as any;
  const userId = session?.auth?.userId;

  try {
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    logger.error({ err }, "Session destroy failed");
    res.status(500).json({ success: false, error: "Session could not be destroyed" });
    return;
  }

  req.log.info({ userId }, "User logged out");
  // Instruct the browser to delete the cookie immediately so it is not
  // replayed on subsequent requests even if the client ignores the session
  // invalidation.  The options must match those used when the cookie was
  // set (path, httpOnly, sameSite) so the browser treats it as the same
  // cookie; Max-Age=0 / Expires-in-the-past is what triggers deletion.
  res.clearCookie("screener.sid", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  res.json({ success: true });
});

export default router;
