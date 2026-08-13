/**
 * Auth routes
 *
 * POST /api/auth/logout       — destroy session
 * GET  /api/auth/status       — return current session auth state
 * GET  /api/auth/login        — initiate Circle OAuth (or mock flow)
 * GET  /api/auth/callback     — OAuth callback; verify Space Group; create session
 *
 * Live-mode OAuth CSRF protection
 * ────────────────────────────────
 * 1. GET /auth/login generates a cryptographically random "state" token,
 *    stores it in the session (session.oauthState), and includes it in
 *    the Circle authorize URL.
 * 2. GET /auth/callback reads the "state" query param and compares it to
 *    session.oauthState before exchanging the code.  A missing or mismatched
 *    state causes an immediate denial without calling Circle — this prevents
 *    CSRF attacks that would inject an attacker's code into a victim's session.
 * 3. session.oauthState is deleted after it is consumed (one-time use).
 */

import { randomBytes }                          from "node:crypto";
import { Router, type IRouter, type Request }   from "express";
import { circleAuthService as defaultCircleAuthService } from "../services.js";
import { logger }                               from "../lib/logger.js";
import type { ICircleAuthService }              from "../lib/circle-auth.js";

/**
 * createAuthRouter — injectable factory used by tests to supply a mock
 * ICircleAuthService without touching module-level state.
 * The top-level default export wires in the production service singleton.
 */
export function createAuthRouter(
  circleAuthService: ICircleAuthService = defaultCircleAuthService,
): IRouter {
const router: IRouter = Router();

// ── GET /auth/status ─────────────────────────────────────────────────────────
// Public.  Always returns the LOCAL /api/auth/login URL, not a direct Circle
// authorize URL, so the redirect_uri is always built server-side with the
// correct host.  Prevents the empty-redirect_uri problem.
router.get("/auth/status", async (req, res): Promise<void> => {
  const session = req.session as any;
  const auth = session?.auth;

  if (!auth) {
    res.json({
      authenticated: false,
      authorized:    false,
      mode:          circleAuthService.mode,
      user:          undefined,
      // Always route the client through our own /auth/login so the
      // redirect_uri is constructed server-side with the correct host.
      loginUrl: "/api/auth/login",
    });
    return;
  }

  res.json({
    authenticated: true,
    authorized:    true,
    mode:          circleAuthService.mode,
    user:          auth.user,
    loginUrl:      null,
  });
});

// ── GET /auth/login ───────────────────────────────────────────────────────────
// Public.  Starts the login flow.
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
        userId:            result.user.id,
        user:              result.user,
        authorizedAt:      Date.now(),
        lastRevalidatedAt: Date.now(),
      };

      req.log.info({ userId: result.user.id, scenario }, "Mock login succeeded");

      if (req.headers.accept?.includes("application/json")) {
        res.json({
          authenticated: true,
          authorized:    true,
          mode:          "mock",
          user:          result.user,
          loginUrl:      null,
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
        authorized:    false,
        mode:          "mock",
        user:          result.user ?? undefined,
        loginUrl:      "/api/auth/login",
      });
    } else {
      res.redirect("/access-restricted");
    }
    return;
  }

  // ── Live mode ────────────────────────────────────────────────────────────
  // Generate a CSRF-protection state token, persist it in the session, then
  // redirect the browser to Circle's OAuth authorize page.
  const state = randomBytes(32).toString("hex");
  session.oauthState = state;

  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0].trim() ?? req.protocol;
  const callbackUrl = `${proto}://${req.get("host")}/api/auth/callback`;
  const baseLoginUrl = circleAuthService.getLoginUrl(callbackUrl);

  // Append the state param to whatever URL getLoginUrl returned.
  const loginUrlWithState = (() => {
    try {
      const u = new URL(baseLoginUrl);
      u.searchParams.set("state", state);
      return u.toString();
    } catch {
      // Fallback: simple append (should never happen with a valid Circle URL)
      const sep = baseLoginUrl.includes("?") ? "&" : "?";
      return `${baseLoginUrl}${sep}state=${encodeURIComponent(state)}`;
    }
  })();

  // Persist the session before redirecting — ensures the state survives the
  // browser round-trip even if the store is lazy about flushing.
  await new Promise<void>((resolve) => {
    req.session.save((err) => {
      if (err) logger.warn({ err }, "Failed to save session before OAuth redirect");
      resolve(); // redirect regardless — state may be lost but we won't crash
    });
  });

  res.redirect(loginUrlWithState);
});

/** Destroy the current session if one exists, then resolve. */
function destroySessionIfPresent(req: Request): Promise<void> {
  return new Promise((resolve) => {
    if (!(req.session as any)?.auth && !(req.session as any)?.oauthState) {
      // Nothing worth destroying.
      resolve();
      return;
    }
    req.session.destroy((err) => {
      if (err) logger.warn({ err }, "Failed to destroy session during auth denial");
      resolve(); // always proceed — denial must still be enforced
    });
  });
}

// ── GET /auth/callback ────────────────────────────────────────────────────────
// OAuth callback handler.
router.get("/auth/callback", async (req, res): Promise<void> => {
  const session = req.session as any;
  const code = typeof req.query.code === "string" ? req.query.code : "";

  // ── CSRF state validation (live mode only) ──────────────────────────────
  // In mock mode there is no state because the browser never left the app.
  if (circleAuthService.mode === "live") {
    const returnedState = typeof req.query.state === "string" ? req.query.state : "";
    const expectedState = typeof session.oauthState === "string" ? session.oauthState : "";

    // Consume the state immediately (one-time use) regardless of outcome.
    delete session.oauthState;

    if (!returnedState || !expectedState || returnedState !== expectedState) {
      // State mismatch — likely a CSRF attempt or a stale link.
      // Destroy the session and deny without calling Circle.
      await destroySessionIfPresent(req);
      req.log.warn(
        { returnedState: returnedState ? "[present]" : "[missing]", expectedState: expectedState ? "[present]" : "[missing]" },
        "Auth callback: OAuth state mismatch — denying",
      );
      res.redirect("/access-restricted");
      return;
    }
  }

  // Reconstruct the exact redirect_uri used during the authorize step —
  // Circle requires it to match in the token exchange.
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0].trim() ?? req.protocol;
  const redirectUri = `${proto}://${req.get("host")}/api/auth/callback`;

  let result;
  try {
    result = await circleAuthService.validateAuthCode(code, redirectUri);
  } catch (err) {
    // Validation threw — destroy any existing session so a stale authorized
    // cookie cannot be replayed after a failed token exchange.
    await destroySessionIfPresent(req);
    // Log full error server-side; never expose it to the client.
    logger.error({ err }, "Auth callback validation failed");
    res.redirect("/access-restricted");
    return;
  }

  if (result.authorized && result.user) {
    session.auth = {
      userId:            result.user.id,
      user:              result.user,
      authorizedAt:      Date.now(),
      lastRevalidatedAt: Date.now(),
    };
    req.log.info({ userId: result.user.id }, "Session created after auth callback");

    if (req.headers.accept?.includes("application/json")) {
      res.json({
        authenticated: true,
        authorized:    true,
        mode:          circleAuthService.mode,
        user:          result.user,
        loginUrl:      null,
      });
    } else {
      res.redirect("/dashboard");
    }
    return;
  }

  // Denied — destroy any existing authorized session so a previously logged-in
  // user (e.g. account-switch, revoked membership) cannot retain access via a
  // stale cookie.
  await destroySessionIfPresent(req);

  req.log.info(
    { authenticated: result.authenticated, authorized: result.authorized },
    "Auth callback: access denied",
  );

  if (req.headers.accept?.includes("application/json")) {
    res.json({
      authenticated: result.authenticated,
      authorized:    false,
      mode:          circleAuthService.mode,
      user:          undefined,
      loginUrl:      "/api/auth/login",
    });
  } else {
    res.redirect("/access-restricted");
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
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
    path:     "/",
  });
  res.json({ success: true });
});

return router;
} // end createAuthRouter

/** Default export wires in the production service singleton. */
export default createAuthRouter();
