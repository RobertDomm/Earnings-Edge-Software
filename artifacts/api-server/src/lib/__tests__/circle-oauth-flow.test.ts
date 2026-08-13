/**
 * circle-oauth-flow.test.ts
 *
 * End-to-end HTTP integration tests for the Circle OAuth callback route.
 *
 * These tests spin up a real Express server with a stubbed ICircleAuthService,
 * exercise the full /auth/login → /auth/callback flow, and assert the session
 * state and redirect behaviour for both the member and non-member paths.
 *
 * Scenarios covered:
 *   1. /auth/status loginUrl — always returns "/api/auth/login" (never a bare
 *      Circle OAuth URL with an empty redirect_uri)
 *   2. Member path — /auth/login generates state → /auth/callback with valid
 *      state creates session, redirects to /dashboard
 *   3. Non-member path — callback denies, redirects to /access-restricted,
 *      no session created
 *   4. CSRF state protection — callback without state, callback with wrong
 *      state, each redirect to /access-restricted without calling Circle
 *   5. Session-reuse / account-switch — an existing authorized session is
 *      cleared when the callback is denied
 *   6. Error path — validateAuthCode throws → /access-restricted, no leak
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import session from "express-session";
import { createAuthRouter } from "../../routes/auth.js";
import type { ICircleAuthService, AuthCheckResult } from "../circle-auth.js";

// ─── Stub ICircleAuthService ──────────────────────────────────────────────────

/** Builds a minimal live-mode ICircleAuthService returning a fixed result. */
function makeStubAuthService(
  result: AuthCheckResult | "throw",
): ICircleAuthService {
  return {
    mode: "live" as const,
    getLoginUrl(callbackUrl?: string): string {
      const u = new URL("https://app.circle.so/oauth/authorize");
      u.searchParams.set("client_id", "test-client");
      u.searchParams.set("redirect_uri", callbackUrl ?? "");
      u.searchParams.set("response_type", "code");
      return u.toString();
    },
    async validateAuthCode(_code, _redirectUri): Promise<AuthCheckResult> {
      if (result === "throw") throw new Error("Simulated Circle API failure");
      return result;
    },
    async revalidateAccess(): Promise<boolean> { return true; },
  };
}

/**
 * Builds a mutable live-mode ICircleAuthService whose result can be changed
 * between requests — used for the account-switch / session-reuse tests.
 */
function makeMutableAuthService(): {
  service: ICircleAuthService;
  setResult(r: AuthCheckResult | "throw"): void;
} {
  let current: AuthCheckResult | "throw" = { authenticated: false, authorized: false };
  return {
    service: {
      mode: "live" as const,
      getLoginUrl(callbackUrl?: string): string {
        const u = new URL("https://app.circle.so/oauth/authorize");
        u.searchParams.set("client_id", "test-client");
        u.searchParams.set("redirect_uri", callbackUrl ?? "");
        u.searchParams.set("response_type", "code");
        return u.toString();
      },
      async validateAuthCode(): Promise<AuthCheckResult> {
        if (current === "throw") throw new Error("Forced error");
        return current;
      },
      async revalidateAccess(): Promise<boolean> { return true; },
    },
    setResult: (r) => { current = r; },
  };
}

// ─── Test Express app factory ─────────────────────────────────────────────────

const TEST_SECRET = "test-session-secret-for-ci-only";
const COOKIE_NAME  = "screener.sid";

function buildAppWithService(svc: ICircleAuthService): express.Express {
  const app = express();
  app.use(express.json());

  // Stub req.log so auth route calls don't throw.
  app.use((req, _res, next) => {
    (req as any).log = {
      info:  () => {},
      warn:  () => {},
      error: () => {},
      debug: () => {},
    };
    next();
  });

  app.use(
    session({
      secret: TEST_SECRET,
      name: COOKIE_NAME,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: false, sameSite: "lax", maxAge: 86400000 },
    }),
  );

  app.use("/api", createAuthRouter(svc));
  return app;
}

// ─── Server lifecycle helpers ─────────────────────────────────────────────────

interface TestServer { url: string; server: Server; }

function startServerWithService(svc: ICircleAuthService): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(buildAppWithService(svc));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
    server.on("error", reject);
  });
}

function startServer(result: AuthCheckResult | "throw"): Promise<TestServer> {
  return startServerWithService(makeStubAuthService(result));
}

function stopServer(s: Server): Promise<void> {
  return new Promise((res, rej) => s.close((e) => (e ? rej(e) : res())));
}

/** Extract "key=value" from a Set-Cookie header (strips attributes). */
function extractCookieValue(setCookie: string | null): string {
  if (!setCookie) throw new Error("No Set-Cookie header");
  return setCookie.split(";")[0].trim();
}

/**
 * Helper: calls GET /api/auth/login, follows NO redirects, and returns:
 *   - cookie: the session cookie from Set-Cookie
 *   - state:  the "state" query param extracted from the Location redirect URL
 *
 * Pass `existingCookie` to initiate a new login flow for an already-authenticated
 * session (account-switch / revocation scenario).  The state is stored in that
 * session so the subsequent callback passes CSRF validation.
 *
 * This is the first leg of the real OAuth flow.  The state is then passed to
 * GET /api/auth/callback so CSRF validation passes.
 */
async function initiateLogin(
  baseUrl: string,
  existingCookie?: string,
): Promise<{ cookie: string; state: string }> {
  const headers: Record<string, string> = {};
  if (existingCookie) headers["Cookie"] = existingCookie;

  const res = await fetch(`${baseUrl}/api/auth/login`, { redirect: "manual", headers });

  // When an existing cookie is sent, express-session may not emit a new Set-Cookie
  // header (the session already exists).  Fall back to the original cookie in that case.
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie ? extractCookieValue(setCookie) : (existingCookie ?? "");

  const location = res.headers.get("location") ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  assert.ok(cookie, "auth/login must produce a session cookie");
  assert.ok(state,  "auth/login must embed a state in the redirect URL");
  return { cookie, state };
}

// ─── 1. /auth/status loginUrl ─────────────────────────────────────────────────

describe("GET /api/auth/status — loginUrl points to local /api/auth/login", () => {
  let ts: TestServer;

  before(async () => {
    ts = await startServer({ authenticated: false, authorized: false });
  });
  after(() => stopServer(ts.server));

  it("loginUrl is /api/auth/login (not a bare Circle OAuth URL)", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { loginUrl: string };
    assert.equal(
      body.loginUrl,
      "/api/auth/login",
      `loginUrl must be the local login endpoint (got: ${body.loginUrl})`,
    );
  });

  it("loginUrl does not contain an empty redirect_uri", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { loginUrl: string };
    assert.ok(
      !body.loginUrl.includes("redirect_uri=&") && !body.loginUrl.includes("redirect_uri=%2"),
      `loginUrl must not contain an empty redirect_uri (got: ${body.loginUrl})`,
    );
  });
});

// ─── 2. /auth/login → /auth/callback — member path ───────────────────────────

describe("GET /api/auth/login + callback — member (authorized: true)", () => {
  let ts: TestServer;

  const MEMBER_USER = {
    id: "circle-1001", name: "Alice Member",
    email: "alice@example.com", avatarUrl: null,
  };

  before(async () => {
    ts = await startServer({ authenticated: true, authorized: true, user: MEMBER_USER });
  });
  after(() => stopServer(ts.server));

  it("/auth/login redirects to Circle OAuth URL with client_id and state", async () => {
    const res = await fetch(`${ts.url}/api/auth/login`, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    assert.ok(location.startsWith("https://app.circle.so/oauth/authorize"),
      `Login must redirect to Circle (got: ${location})`);
    assert.ok(location.includes("client_id="),
      `Circle URL must include client_id (got: ${location})`);
    assert.ok(
      new URL(location).searchParams.get("state") !== null,
      `Circle URL must include a state param (got: ${location})`,
    );
  });

  it("/auth/login sets a session cookie that stores the state", async () => {
    const { cookie } = await initiateLogin(ts.url);
    assert.ok(cookie.startsWith(`${COOKIE_NAME}=`),
      `Login must set a ${COOKIE_NAME} cookie`);
  });

  it("callback with valid state redirects to /dashboard", async () => {
    const { cookie, state } = await initiateLogin(ts.url);
    const res = await fetch(
      `${ts.url}/api/auth/callback?code=member-code&state=${state}`,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    const location = res.headers.get("location");
    assert.ok(location?.includes("/dashboard"),
      `Member callback must redirect to /dashboard (got: ${location})`);
  });

  it("callback with valid state sets a session cookie", async () => {
    const { cookie, state } = await initiateLogin(ts.url);
    const res = await fetch(
      `${ts.url}/api/auth/callback?code=member-code&state=${state}`,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie?.includes(`${COOKIE_NAME}=`),
      `Member callback must refresh the session cookie`);
  });

  it("/auth/status with callback cookie returns authenticated: true, authorized: true", async () => {
    const { cookie, state } = await initiateLogin(ts.url);
    const cbRes = await fetch(
      `${ts.url}/api/auth/callback?code=member-code&state=${state}`,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    const sessionCookie = extractCookieValue(cbRes.headers.get("set-cookie"));

    const status = await fetch(`${ts.url}/api/auth/status`, {
      headers: { Cookie: sessionCookie },
    });
    const body = (await status.json()) as {
      authenticated: boolean; authorized: boolean; user?: { email: string };
    };
    assert.equal(body.authenticated, true);
    assert.equal(body.authorized,    true);
    assert.equal(body.user?.email,   MEMBER_USER.email);
  });

  it("JSON client on callback receives authenticated: true with user data", async () => {
    const { cookie, state } = await initiateLogin(ts.url);
    const res = await fetch(
      `${ts.url}/api/auth/callback?code=member-code&state=${state}`,
      { headers: { Accept: "application/json", Cookie: cookie } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      authenticated: boolean; authorized: boolean; user?: { id: string; email: string };
    };
    assert.equal(body.authenticated, true);
    assert.equal(body.authorized,    true);
    assert.equal(body.user?.id,      MEMBER_USER.id);
    assert.equal(body.user?.email,   MEMBER_USER.email);
  });
});

// ─── 3. Non-member path ───────────────────────────────────────────────────────

describe("GET /api/auth/callback — non-member (authorized: false)", () => {
  let ts: TestServer;

  before(async () => {
    ts = await startServer({ authenticated: true, authorized: false });
  });
  after(() => stopServer(ts.server));

  it("callback with valid state redirects to /access-restricted", async () => {
    const { cookie, state } = await initiateLogin(ts.url);
    const res = await fetch(
      `${ts.url}/api/auth/callback?code=nonmember&state=${state}`,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    const location = res.headers.get("location");
    assert.ok(location?.includes("/access-restricted"),
      `Non-member must be redirected to /access-restricted (got: ${location})`);
  });

  it("JSON client on denied callback receives authorized: false, loginUrl is /api/auth/login", async () => {
    const { cookie, state } = await initiateLogin(ts.url);
    const res = await fetch(
      `${ts.url}/api/auth/callback?code=nonmember&state=${state}`,
      { headers: { Accept: "application/json", Cookie: cookie } },
    );
    const body = (await res.json()) as {
      authenticated: boolean; authorized: boolean; loginUrl: string; user?: unknown;
    };
    assert.equal(body.authenticated, true);
    assert.equal(body.authorized,    false);
    assert.equal(body.user,          undefined);
    assert.equal(body.loginUrl,      "/api/auth/login",
      `Denied callback loginUrl must be /api/auth/login (got: ${body.loginUrl})`);
  });

  it("/auth/status after denial returns authenticated: false", async () => {
    // Simulate a fresh client with no cookie — the denial path doesn't issue one
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { authenticated: boolean };
    assert.equal(body.authenticated, false);
  });
});

// ─── 4. CSRF state protection ─────────────────────────────────────────────────

describe("GET /api/auth/callback — CSRF state validation", () => {
  let ts: TestServer;

  const MEMBER_USER = {
    id: "circle-csrf", name: "CSRF Test Member",
    email: "csrf@example.com", avatarUrl: null,
  };

  before(async () => {
    // Use an authorized service so any state mismatch is clearly the cause of denial.
    ts = await startServer({ authenticated: true, authorized: true, user: MEMBER_USER });
  });
  after(() => stopServer(ts.server));

  it("callback with NO state is redirected to /access-restricted", async () => {
    // Initiate login to get a valid session (state stored in session), then
    // call callback WITHOUT state param.
    const { cookie } = await initiateLogin(ts.url);
    const res = await fetch(
      `${ts.url}/api/auth/callback?code=some-code`,       // no &state=
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    const location = res.headers.get("location");
    assert.ok(location?.includes("/access-restricted"),
      `Missing state must redirect to /access-restricted (got: ${location})`);
  });

  it("callback with WRONG state is redirected to /access-restricted", async () => {
    const { cookie } = await initiateLogin(ts.url);
    const res = await fetch(
      `${ts.url}/api/auth/callback?code=some-code&state=definitely-wrong-state`,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    const location = res.headers.get("location");
    assert.ok(location?.includes("/access-restricted"),
      `Wrong state must redirect to /access-restricted (got: ${location})`);
  });

  it("callback with correct state succeeds and creates a session", async () => {
    const { cookie, state } = await initiateLogin(ts.url);
    const res = await fetch(
      `${ts.url}/api/auth/callback?code=some-code&state=${state}`,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    const location = res.headers.get("location");
    assert.ok(location?.includes("/dashboard"),
      `Correct state must reach /dashboard (got: ${location})`);
  });

  it("state is one-time-use: replaying the same code+state is rejected", async () => {
    const { cookie, state } = await initiateLogin(ts.url);
    const callbackUrl = `${ts.url}/api/auth/callback?code=some-code&state=${state}`;

    // First callback — should succeed.
    const first = await fetch(callbackUrl, {
      redirect: "manual",
      headers: { Cookie: cookie },
    });
    assert.ok(first.headers.get("location")?.includes("/dashboard"),
      "First callback must succeed");

    // Use the refreshed session cookie from the first callback.
    const refreshedCookie = extractCookieValue(first.headers.get("set-cookie"));

    // Second callback with the same state — must fail (state consumed on first use).
    const second = await fetch(callbackUrl, {
      redirect: "manual",
      headers: { Cookie: refreshedCookie },
    });
    const secondLocation = second.headers.get("location");
    assert.ok(secondLocation?.includes("/access-restricted"),
      `Replayed state must redirect to /access-restricted (got: ${secondLocation})`);
  });
});

// ─── 5. Session-reuse / account-switch ───────────────────────────────────────

describe("GET /api/auth/callback — existing authorized session cleared on denial", () => {
  let ts: TestServer;
  let setResult: (r: AuthCheckResult | "throw") => void;

  const MEMBER_USER = {
    id: "circle-switch", name: "Previously Authorized",
    email: "was-member@example.com", avatarUrl: null,
  };

  before(async () => {
    const mutable = makeMutableAuthService();
    setResult = mutable.setResult;
    ts = await startServerWithService(mutable.service);
  });
  after(() => stopServer(ts.server));

  it("denied callback clears existing session — old cookie is no longer authenticated", async () => {
    // Step 1: Create an authorized session.
    setResult({ authenticated: true, authorized: true, user: MEMBER_USER });
    const { cookie: loginCookie, state: loginState } = await initiateLogin(ts.url);
    const authCbRes = await fetch(
      `${ts.url}/api/auth/callback?code=member-code&state=${loginState}`,
      { redirect: "manual", headers: { Cookie: loginCookie } },
    );
    const authCookie = extractCookieValue(authCbRes.headers.get("set-cookie"));

    // Confirm session is live.
    const before = (await (await fetch(`${ts.url}/api/auth/status`, {
      headers: { Cookie: authCookie },
    })).json()) as { authenticated: boolean };
    assert.equal(before.authenticated, true, "Session must be live before denial");

    // Step 2: Initiate a new login flow using the AUTHORIZED cookie so the
    // fresh state token is stored in that same session (not a new one).
    const { cookie: loginCookieAfter, state: newState } = await initiateLogin(ts.url, authCookie);

    // Step 3: Invoke a denied callback with the live session cookie + new state.
    setResult({ authenticated: true, authorized: false });
    await fetch(
      `${ts.url}/api/auth/callback?code=denied-code&state=${newState}`,
      { redirect: "manual", headers: { Cookie: loginCookieAfter } },
    );

    // Step 4: The old cookie must no longer authenticate.
    const after = (await (await fetch(`${ts.url}/api/auth/status`, {
      headers: { Cookie: authCookie },
    })).json()) as { authenticated: boolean; authorized: boolean };
    assert.equal(after.authenticated, false,
      "Old cookie must not authenticate after denial — session must be destroyed");
    assert.equal(after.authorized, false);
  });

  it("error callback with existing session destroys that session", async () => {
    // Step 1: Create an authorized session.
    setResult({ authenticated: true, authorized: true, user: MEMBER_USER });
    const { cookie: loginCookie, state: loginState } = await initiateLogin(ts.url);
    const authCbRes = await fetch(
      `${ts.url}/api/auth/callback?code=member-code&state=${loginState}`,
      { redirect: "manual", headers: { Cookie: loginCookie } },
    );
    const authCookie = extractCookieValue(authCbRes.headers.get("set-cookie"));

    // Step 2: Start a fresh login flow using the AUTHORIZED cookie so the
    // fresh state is stored in that same session.
    const { cookie: loginCookieAfter, state: newState } = await initiateLogin(ts.url, authCookie);

    // Step 3: Simulate a Circle API failure during callback.
    setResult("throw");
    await fetch(
      `${ts.url}/api/auth/callback?code=error-code&state=${newState}`,
      { redirect: "manual", headers: { Cookie: loginCookieAfter } },
    );

    // Step 4: Old session must be gone.
    const after = (await (await fetch(`${ts.url}/api/auth/status`, {
      headers: { Cookie: authCookie },
    })).json()) as { authenticated: boolean };
    assert.equal(after.authenticated, false,
      "Session must be destroyed even when the callback throws");
  });
});

// ─── 6. Error path ────────────────────────────────────────────────────────────

describe("GET /api/auth/callback — validateAuthCode throws", () => {
  let ts: TestServer;

  before(async () => {
    ts = await startServer("throw");
  });
  after(() => stopServer(ts.server));

  it("redirects to /access-restricted when Circle API throws", async () => {
    const { cookie, state } = await initiateLogin(ts.url);
    const res = await fetch(
      `${ts.url}/api/auth/callback?code=bad-code&state=${state}`,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    const location = res.headers.get("location");
    assert.ok(location?.includes("/access-restricted"),
      `Error path must redirect to /access-restricted (got: ${location})`);
  });

  it("does not expose the internal error in the response body", async () => {
    const { cookie, state } = await initiateLogin(ts.url);
    const res = await fetch(
      `${ts.url}/api/auth/callback?code=bad-code&state=${state}`,
      { redirect: "follow", headers: { Cookie: cookie } },
    );
    const text = await res.text();
    assert.ok(!text.includes("Simulated Circle API failure"),
      "Internal error message must not be exposed");
    assert.ok(!text.includes("at Object.") && !text.includes("at async"),
      "Stack trace must not be exposed");
  });
});
