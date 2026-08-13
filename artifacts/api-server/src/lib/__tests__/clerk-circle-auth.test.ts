/**
 * clerk-circle-auth.test.ts
 *
 * Confirms that a signed-in Clerk user who is NOT a Circle Space Group member
 * is blocked — not silently let through — at every layer of the auth gate.
 *
 * Scenarios covered:
 *
 *   Layer 1 — getUserAuthInfo (circle-membership.ts)
 *     1.  Non-member email → Circle returns empty array  → authorized: false
 *     2.  Non-member email → Circle returns 404          → authorized: false
 *     3.  Member email     → Circle returns record       → authorized: true
 *     4.  Circle env vars missing                        → authorized: false (fail-closed)
 *     5.  Circle API responds non-2xx                    → authorized: false (fail-closed)
 *     6.  Circle API throws (network/timeout)            → authorized: false (fail-closed)
 *     7.  Clerk user lookup fails                        → authorized: false (fail-closed)
 *     8.  Clerk user has no email                        → authorized: false (fail-closed)
 *
 *   Layer 2 — requireAuth middleware (middlewares/require-auth.ts)
 *     9.  No userId (unauthenticated)                    → 401
 *     10. userId present, Circle denies                  → 403
 *     11. userId present, Circle allows                  → calls next()
 *     12. getUserInfo throws                             → 401 (not 500; no leak)
 *
 *   Layer 3 — GET /auth/status route (routes/auth.ts)
 *     13. No userId                                      → { authenticated: false, authorized: false }
 *     14. userId present, non-member                     → { authenticated: true, authorized: false, user: undefined }
 *     15. userId present, member                         → { authenticated: true, authorized: true, user: { email } }
 *     16. getUserInfo throws                             → { authenticated: true, authorized: false }
 *     17. Non-member status body does not expose email   → user field absent/undefined
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { createGetUserAuthInfo } from "../circle-membership.js";
import { createRequireAuth } from "../../middlewares/require-auth.js";
import { createAuthStatusRouter } from "../../routes/auth.js";

// ─── Shared test fixtures ─────────────────────────────────────────────────────

const NON_MEMBER_EMAIL   = "nonmember@example.com";
const MEMBER_EMAIL       = "member@example.com";
const NON_MEMBER_USER_ID = "user_nonmember_001";
const MEMBER_USER_ID     = "user_member_001";

/** Minimal Clerk user record for the non-member. */
const NON_MEMBER_CLERK_USER = {
  primaryEmailAddressId: "email_nm_1",
  emailAddresses: [{ id: "email_nm_1", emailAddress: NON_MEMBER_EMAIL }],
};

/** Minimal Clerk user record for the member. */
const MEMBER_CLERK_USER = {
  primaryEmailAddressId: "email_m_1",
  emailAddresses: [{ id: "email_m_1", emailAddress: MEMBER_EMAIL }],
};

/** Valid Circle env vars for tests that exercise the fetch path. */
const CIRCLE_ENV = {
  CIRCLE_COMMUNITY_ID:             "test-community-123",
  CIRCLE_REQUIRED_SPACE_GROUP_ID:  "test-group-456",
  CIRCLE_API_TOKEN:                "test-api-token-abc",
};

/** Sets Circle env vars and returns a teardown function. */
function withCircleEnv(): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(CIRCLE_ENV)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k] of Object.entries(CIRCLE_ENV)) {
      const v = prev[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Clears Circle env vars and returns a teardown function. */
function withoutCircleEnv(): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(CIRCLE_ENV)) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v !== undefined) process.env[k] = v;
    }
  };
}

/** Builds a minimal fetch mock that returns the given JSON body + status. */
function makeFetchMock(status: number, body: unknown): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

/** Builds a fetch mock that throws a network error. */
function makeThrowingFetchMock(): typeof globalThis.fetch {
  return async () => {
    throw new Error("Network timeout");
  };
}

/** Saves and restores globalThis.fetch around a test. */
function saveFetch(): () => void {
  const original = globalThis.fetch;
  return () => { globalThis.fetch = original; };
}

// ─── HTTP test helpers ────────────────────────────────────────────────────────

interface TestServer { url: string; server: Server; }

/**
 * A fake `getAuth` function that reads `(req as any)._testUserId` so tests can
 * control the userId without running real Clerk middleware.
 */
function makeGetAuth(userId: string | null) {
  return (_req: express.Request) => ({ userId });
}

/** Starts an Express test server on a random port and resolves with its URL. */
function startServer(app: express.Express): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
    server.on("error", reject);
  });
}

function stopServer(s: Server): Promise<void> {
  return new Promise((res, rej) => s.close((e) => (e ? rej(e) : res())));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 1 — getUserAuthInfo (circle-membership.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe("getUserAuthInfo — Circle returns empty array (non-member)", () => {
  let restore: () => void;
  let restoreFetch: () => void;

  before(() => {
    restore = withCircleEnv();
    restoreFetch = saveFetch();
    globalThis.fetch = makeFetchMock(200, []);   // empty array → not a member
  });
  after(() => { restoreFetch(); restore(); });

  it("returns authorized: false", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(async () => NON_MEMBER_CLERK_USER);
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false, "Non-member must not be authorized");
  });

  it("returns the correct email", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(async () => NON_MEMBER_CLERK_USER);
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.email, NON_MEMBER_EMAIL);
  });
});

describe("getUserAuthInfo — Circle returns 404 (non-member)", () => {
  let restore: () => void;
  let restoreFetch: () => void;

  before(() => {
    restore = withCircleEnv();
    restoreFetch = saveFetch();
    globalThis.fetch = makeFetchMock(404, { message: "Not Found" });
  });
  after(() => { restoreFetch(); restore(); });

  it("returns authorized: false", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(async () => NON_MEMBER_CLERK_USER);
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false);
  });
});

describe("getUserAuthInfo — Circle returns member record (member)", () => {
  let restore: () => void;
  let restoreFetch: () => void;

  before(() => {
    restore = withCircleEnv();
    restoreFetch = saveFetch();
    globalThis.fetch = makeFetchMock(200, [{ email: MEMBER_EMAIL, community_member_id: 42 }]);
  });
  after(() => { restoreFetch(); restore(); });

  it("returns authorized: true", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(async () => MEMBER_CLERK_USER);
    const result = await getUserAuthInfo(MEMBER_USER_ID);
    assert.equal(result.authorized, true, "Confirmed member must be authorized");
  });

  it("returns the correct email", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(async () => MEMBER_CLERK_USER);
    const result = await getUserAuthInfo(MEMBER_USER_ID);
    assert.equal(result.email, MEMBER_EMAIL);
  });
});

describe("getUserAuthInfo — Circle env vars missing (fail-closed)", () => {
  let restore: () => void;

  before(() => { restore = withoutCircleEnv(); });
  after(() => { restore(); });

  it("returns authorized: false when env vars are absent", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(async () => NON_MEMBER_CLERK_USER);
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false, "Missing env vars must deny access");
  });
});

describe("getUserAuthInfo — Circle API responds non-2xx (fail-closed)", () => {
  let restore: () => void;
  let restoreFetch: () => void;

  before(() => {
    restore = withCircleEnv();
    restoreFetch = saveFetch();
    globalThis.fetch = makeFetchMock(500, { error: "Internal Server Error" });
  });
  after(() => { restoreFetch(); restore(); });

  it("returns authorized: false on 5xx", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(async () => NON_MEMBER_CLERK_USER);
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false, "5xx from Circle must deny access");
  });
});

describe("getUserAuthInfo — Circle API throws network error (fail-closed)", () => {
  let restore: () => void;
  let restoreFetch: () => void;

  before(() => {
    restore = withCircleEnv();
    restoreFetch = saveFetch();
    globalThis.fetch = makeThrowingFetchMock();
  });
  after(() => { restoreFetch(); restore(); });

  it("returns authorized: false when fetch throws", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(async () => NON_MEMBER_CLERK_USER);
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false, "Network error must deny access");
  });
});

describe("getUserAuthInfo — Clerk user lookup fails (fail-closed)", () => {
  it("returns authorized: false when Clerk throws", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(async () => {
      throw new Error("Clerk API unavailable");
    });
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false, "Clerk failure must deny access");
    assert.equal(result.email, "", "Email must be empty on Clerk failure");
  });
});

describe("getUserAuthInfo — Clerk user has no email (fail-closed)", () => {
  let restore: () => void;

  before(() => { restore = withCircleEnv(); });
  after(() => { restore(); });

  it("returns authorized: false when the Clerk user has no email addresses", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(async () => ({
      primaryEmailAddressId: null,
      emailAddresses: [],
    }));
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false, "User with no email must be denied");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 2 — requireAuth middleware
// ═══════════════════════════════════════════════════════════════════════════════

describe("requireAuth middleware — unauthenticated request (no userId)", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    const mw = createRequireAuth(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),   // no active Clerk session
    );
    app.get("/protected", mw, (_req, res) => res.json({ ok: true }));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 401", async () => {
    const res = await fetch(`${ts.url}/protected`);
    assert.equal(res.status, 401, `Expected 401 for unauthenticated caller, got ${res.status}`);
  });

  it("body contains an error field", async () => {
    const res = await fetch(`${ts.url}/protected`);
    const body = (await res.json()) as { error: string };
    assert.ok(typeof body.error === "string" && body.error.length > 0);
  });
});

describe("requireAuth middleware — signed-in but not a Circle member", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    const mw = createRequireAuth(
      async () => ({ email: NON_MEMBER_EMAIL, authorized: false }),
      makeGetAuth(NON_MEMBER_USER_ID),
    );
    app.get("/protected", mw, (_req, res) => res.json({ ok: true }));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 403", async () => {
    const res = await fetch(`${ts.url}/protected`);
    assert.equal(
      res.status,
      403,
      `Non-member must be blocked with 403, got ${res.status}`,
    );
  });

  it("does NOT reach the protected route handler", async () => {
    const res = await fetch(`${ts.url}/protected`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(body["ok"] !== true, "Protected handler must not run for non-member");
  });

  it("body contains a meaningful error message", async () => {
    const res = await fetch(`${ts.url}/protected`);
    const body = (await res.json()) as { error: string };
    assert.ok(
      typeof body.error === "string" && body.error.length > 0,
      `403 body must include an error string (got: ${JSON.stringify(body.error)})`,
    );
  });

  it("error message does not leak the user's email", async () => {
    const res = await fetch(`${ts.url}/protected`);
    const text = await res.text();
    assert.ok(
      !text.includes(NON_MEMBER_EMAIL),
      "403 error body must not include the user's email address",
    );
  });
});

describe("requireAuth middleware — signed-in Circle member is allowed through", () => {
  let ts: TestServer;
  let reachedHandler: boolean;

  before(async () => {
    reachedHandler = false;
    const app = express();
    app.use(express.json());
    const mw = createRequireAuth(
      async () => ({ email: MEMBER_EMAIL, authorized: true }),
      makeGetAuth(MEMBER_USER_ID),
    );
    app.get("/protected", mw, (_req, res) => {
      reachedHandler = true;
      res.json({ ok: true });
    });
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 200", async () => {
    const res = await fetch(`${ts.url}/protected`);
    assert.equal(res.status, 200, `Member must be allowed through, got ${res.status}`);
  });

  it("the protected route handler is actually called", async () => {
    await fetch(`${ts.url}/protected`);
    assert.ok(reachedHandler, "Route handler must be invoked for an authorized member");
  });
});

describe("requireAuth middleware — getUserInfo throws (fail-closed)", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    const mw = createRequireAuth(
      async () => { throw new Error("Upstream auth check failed"); },
      makeGetAuth("user_error_999"),
    );
    app.get("/protected", mw, (_req, res) => res.json({ ok: true }));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 401 (not 500) when getUserInfo throws", async () => {
    const res = await fetch(`${ts.url}/protected`);
    assert.equal(res.status, 401, `Error path must return 401, got ${res.status}`);
  });

  it("does not expose the internal error message", async () => {
    const res = await fetch(`${ts.url}/protected`);
    const text = await res.text();
    assert.ok(
      !text.includes("Upstream auth check failed"),
      "Internal error must not be surfaced to the caller",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 3 — GET /auth/status route
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /auth/status — unauthenticated (no Clerk session)", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createAuthStatusRouter(
        async () => ({ email: "", authorized: false }),
        makeGetAuth(null),
      ),
    );
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 200 (status endpoint is always public)", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    assert.equal(res.status, 200);
  });

  it("body has authenticated: false", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { authenticated: boolean };
    assert.equal(body.authenticated, false);
  });

  it("body has authorized: false", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { authorized: boolean };
    assert.equal(body.authorized, false);
  });

  it("body.mode is 'clerk'", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { mode: string };
    assert.equal(body.mode, "clerk");
  });
});

describe("GET /auth/status — signed-in user who is NOT a Circle member", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createAuthStatusRouter(
        async () => ({ email: NON_MEMBER_EMAIL, authorized: false }),
        makeGetAuth(NON_MEMBER_USER_ID),
      ),
    );
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 200 (status endpoint is always public)", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    assert.equal(res.status, 200);
  });

  it("body has authenticated: true (Clerk auth succeeded)", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { authenticated: boolean };
    assert.equal(
      body.authenticated,
      true,
      "Non-member is still Clerk-authenticated",
    );
  });

  it("body has authorized: false (Circle denied)", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { authorized: boolean };
    assert.equal(
      body.authorized,
      false,
      "Non-member must NOT be authorized",
    );
  });

  it("body.user is absent — email is not exposed for non-members", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { user?: unknown };
    assert.ok(
      body.user === undefined || body.user === null,
      `user field must be absent/null for non-member (got: ${JSON.stringify(body.user)})`,
    );
  });

  it("body.mode is 'clerk'", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { mode: string };
    assert.equal(body.mode, "clerk");
  });
});

describe("GET /auth/status — signed-in Circle member", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createAuthStatusRouter(
        async () => ({ email: MEMBER_EMAIL, authorized: true }),
        makeGetAuth(MEMBER_USER_ID),
      ),
    );
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("body has authenticated: true", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { authenticated: boolean };
    assert.equal(body.authenticated, true);
  });

  it("body has authorized: true", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { authorized: boolean };
    assert.equal(body.authorized, true);
  });

  it("body.user.email matches the member's email", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { user?: { email: string } };
    assert.equal(
      body.user?.email,
      MEMBER_EMAIL,
      "Status must include email for authorized member",
    );
  });
});

describe("GET /auth/status — getUserInfo throws (fail-closed)", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createAuthStatusRouter(
        async () => { throw new Error("Internal auth check failure"); },
        makeGetAuth("user_error_999"),
      ),
    );
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 200 (status route is always public)", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    assert.equal(res.status, 200);
  });

  it("body has authorized: false (fail-closed)", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const body = (await res.json()) as { authorized: boolean };
    assert.equal(
      body.authorized,
      false,
      "Error path must deny access (fail-closed)",
    );
  });

  it("does not expose the internal error in the response", async () => {
    const res = await fetch(`${ts.url}/api/auth/status`);
    const text = await res.text();
    assert.ok(
      !text.includes("Internal auth check failure"),
      "Internal error must not leak to the response body",
    );
  });
});
