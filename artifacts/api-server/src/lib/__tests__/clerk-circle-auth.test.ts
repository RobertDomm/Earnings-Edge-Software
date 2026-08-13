/**
 * clerk-circle-auth.test.ts
 *
 * Confirms that a signed-in Clerk user who is NOT a Circle Space Group member
 * is blocked — not silently let through — at every layer of the auth gate.
 *
 * Scenarios covered:
 *
 *   Layer 0 — POST /auth/preflight (routes/auth.ts)
 *     0a. Non-member email → checkMembership returns false → { authorized: false }, HTTP 200
 *     0b. Member email → checkMembership returns true → { authorized: true }, HTTP 200
 *     0c. Missing email body field → HTTP 400
 *     0d. Non-string email body field → HTTP 400
 *     0e. Email is trimmed + lowercased before the membership check
 *     0f. checkMembership throws → HTTP 503 with circle_unavailable (Circle outage ≠ membership denial)
 *     0g. Non-member response never exposes email in the body
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
 *   Layer 4 — Clerk JWT token expiry (requireAuth middleware, expiry-specific)
 *     18. Expired JWT → getAuth returns userId: null     → 401 (not silent, not 500)
 *     19. Expired JWT 401 body has an error field        → no leak of session detail
 *     20. Expired JWT never reaches the protected handler
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { createGetUserAuthInfo, checkEmailMembership } from "../circle-membership.js";
import { createRequireAuth } from "../../middlewares/require-auth.js";
import { createAuthStatusRouter } from "../../routes/auth.js";
import { createRateLimiter } from "../rate-limiter.js";

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

/**
 * A no-op rate limiter that always calls next().
 * Use this in describe blocks that test Circle API error paths — those blocks
 * share the module-level defaultPreflightLimiter singleton, which can be
 * exhausted by earlier suites (all running from 127.0.0.1), causing spurious
 * 429s that mask the 503 or 200 we are actually asserting.
 */
const noopLimiter: import("express").RequestHandler = (_req, _res, next) => next();

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
// Layer 0 — POST /auth/preflight
//
// This is the earliest possible gate: the frontend calls /auth/preflight with
// the user's email BEFORE Clerk ever sends a verification code.  A non-member
// must receive { authorized: false } immediately; Clerk is never touched.
//
// Each test injects a deterministic `checkMembership` stub via the third
// parameter of createAuthStatusRouter, so no real Circle API calls are made
// and no globalThis.fetch mutation is needed.
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /auth/preflight — non-member email is denied before Clerk sends a code", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    // checkMembership stub always returns false (non-member)
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      async (_email: string) => false,
      noopLimiter,
    ));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 200", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it("body has authorized: false", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    const body = (await res.json()) as { authorized: boolean };
    assert.equal(
      body.authorized,
      false,
      "Non-member must receive authorized: false — Clerk must never send them a code",
    );
  });

  it("response body does not expose the submitted email", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    const text = await res.text();
    assert.ok(
      !text.includes(NON_MEMBER_EMAIL),
      "Preflight response must not echo the email back for a non-member",
    );
  });
});

describe("POST /auth/preflight — member email is approved", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    // checkMembership stub always returns true (member)
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: MEMBER_EMAIL, authorized: true }),
      makeGetAuth(null),
      async (_email: string) => true,
      noopLimiter,
    ));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 200", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: MEMBER_EMAIL }),
    });
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it("body has authorized: true", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: MEMBER_EMAIL }),
    });
    const body = (await res.json()) as { authorized: boolean };
    assert.equal(
      body.authorized,
      true,
      "Circle member must receive authorized: true so Clerk proceeds to send a code",
    );
  });
});

describe("POST /auth/preflight — missing email field returns 400", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      async (_email: string) => false,
      noopLimiter,
    ));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 400 when email is absent from the body", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400, `Expected 400 for missing email, got ${res.status}`);
  });

  it("error body contains an error field", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { error: string };
    assert.ok(typeof body.error === "string" && body.error.length > 0,
      "400 body must contain a non-empty error string");
  });
});

describe("POST /auth/preflight — non-string email field returns 400", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      async (_email: string) => false,
      noopLimiter,
    ));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 400 when email is not a string (e.g. a number)", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: 12345 }),
    });
    assert.equal(res.status, 400, `Expected 400 for non-string email, got ${res.status}`);
  });
});

describe("POST /auth/preflight — email is normalised before the membership check", () => {
  let ts: TestServer;
  let capturedEmail: string | null;

  before(async () => {
    capturedEmail = null;
    const app = express();
    app.use(express.json());
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      async (email: string) => {
        capturedEmail = email;
        return false;
      },
      noopLimiter,
    ));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("trims whitespace and lowercases the email before calling checkMembership", async () => {
    await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "  Member@Example.COM  " }),
    });
    assert.equal(
      capturedEmail,
      "member@example.com",
      `checkMembership must receive a trimmed, lowercased email (got: ${capturedEmail})`,
    );
  });
});

describe("POST /auth/preflight — checkMembership throws returns 503 (Circle unavailable, not a denial)", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      async (_email: string) => { throw new Error("Circle API unavailable"); },
      noopLimiter,
    ));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 503 (not 200/403 — Circle outage is distinct from a membership denial)", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    assert.equal(res.status, 503, `Expected 503 when checkMembership throws (Circle unavailable), got ${res.status}`);
  });

  it("does not expose the internal error message", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    const text = await res.text();
    assert.ok(
      !text.includes("Circle API unavailable"),
      "Internal error detail must not be exposed in the preflight response",
    );
  });

  it("response body contains a circle_unavailable error code", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    const body = (await res.json()) as { error: string };
    assert.equal(
      body.error,
      "circle_unavailable",
      `503 body must use error code 'circle_unavailable' (got: ${JSON.stringify(body.error)})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 1 — getUserAuthInfo (circle-membership.ts)
//
// Each test passes its Circle API mock as `fetchImpl` directly to
// createGetUserAuthInfo, rather than mutating globalThis.fetch.
// This prevents inter-suite races when Node's test runner executes
// describe blocks concurrently.
// ═══════════════════════════════════════════════════════════════════════════════

describe("getUserAuthInfo — Circle returns 200 with no valid member record (non-member)", () => {
  let restore: () => void;
  before(() => { restore = withCircleEnv(); });
  after(() => { restore(); });

  it("returns authorized: false when body has no numeric id", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => NON_MEMBER_CLERK_USER,
      // Singular endpoint returns 200 + object; a missing/non-numeric id = not a member
      makeFetchMock(200, {}),
    );
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false, "Non-member must not be authorized");
  });

  it("returns the correct email", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => NON_MEMBER_CLERK_USER,
      makeFetchMock(200, {}),
    );
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.email, NON_MEMBER_EMAIL);
  });
});

describe("getUserAuthInfo — Circle returns 404 (non-member)", () => {
  let restore: () => void;
  before(() => { restore = withCircleEnv(); });
  after(() => { restore(); });

  it("returns authorized: false", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => NON_MEMBER_CLERK_USER,
      makeFetchMock(404, { message: "Not Found" }),
    );
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false);
  });
});

describe("getUserAuthInfo — Circle returns active member record (member)", () => {
  let restore: () => void;
  before(() => { restore = withCircleEnv(); });
  after(() => { restore(); });

  it("returns authorized: true", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => MEMBER_CLERK_USER,
      // Singular endpoint returns a single object with a numeric id and status: "active"
      makeFetchMock(200, { id: 42, community_member_id: 1234, status: "active" }),
    );
    const result = await getUserAuthInfo(MEMBER_USER_ID);
    assert.equal(result.authorized, true, "Active member must be authorized");
  });

  it("returns the correct email", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => MEMBER_CLERK_USER,
      makeFetchMock(200, { id: 42, community_member_id: 1234, status: "active" }),
    );
    const result = await getUserAuthInfo(MEMBER_USER_ID);
    assert.equal(result.email, MEMBER_EMAIL);
  });
});

describe("getUserAuthInfo — Circle returns inactive member record (invited but not joined)", () => {
  let restore: () => void;
  before(() => { restore = withCircleEnv(); });
  after(() => { restore(); });

  it("returns authorized: false for status: inactive", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => MEMBER_CLERK_USER,
      makeFetchMock(200, { id: 42, community_member_id: 1234, status: "inactive" }),
    );
    const result = await getUserAuthInfo(MEMBER_USER_ID);
    assert.equal(result.authorized, false, "Inactive member must NOT be authorized — invited but not joined");
  });

  it("returns authorized: false for a record with an id but no status field", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => MEMBER_CLERK_USER,
      // Missing status — treat as non-active (fail-closed)
      makeFetchMock(200, { id: 42, community_member_id: 1234 }),
    );
    const result = await getUserAuthInfo(MEMBER_USER_ID);
    assert.equal(result.authorized, false, "Record without status must be denied (fail-closed)");
  });
});

describe("getUserAuthInfo — Circle env vars missing (fail-closed)", () => {
  let restore: () => void;
  before(() => { restore = withoutCircleEnv(); });
  after(() => { restore(); });

  it("returns authorized: false when env vars are absent", async () => {
    // fetchImpl is never reached when env vars are missing, but we still
    // inject a neutral mock to avoid any globalThis.fetch dependency.
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => NON_MEMBER_CLERK_USER,
      makeFetchMock(200, []),
    );
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false, "Missing env vars must deny access");
  });
});

describe("getUserAuthInfo — Circle API responds non-2xx (fail-closed)", () => {
  let restore: () => void;
  before(() => { restore = withCircleEnv(); });
  after(() => { restore(); });

  it("returns authorized: false on 5xx", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => NON_MEMBER_CLERK_USER,
      makeFetchMock(500, { error: "Internal Server Error" }),
    );
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false, "5xx from Circle must deny access");
  });
});

describe("getUserAuthInfo — Circle API throws network error (fail-closed)", () => {
  let restore: () => void;
  before(() => { restore = withCircleEnv(); });
  after(() => { restore(); });

  it("returns authorized: false when fetch throws", async () => {
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => NON_MEMBER_CLERK_USER,
      makeThrowingFetchMock(),
    );
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
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => ({ primaryEmailAddressId: null, emailAddresses: [] }),
      makeFetchMock(200, []),
    );
    const result = await getUserAuthInfo(NON_MEMBER_USER_ID);
    assert.equal(result.authorized, false, "User with no email must be denied");
  });
});

describe("getUserAuthInfo — every non-active Circle status is denied (fail-closed)", () => {
  let restore: () => void;
  before(() => { restore = withCircleEnv(); });
  after(() => { restore(); });

  const NON_ACTIVE_STATUSES: unknown[] = [
    "banned",
    "pending",
    "expired",
    "suspended",
    "deleted",
    "Active",              // wrong case must NOT be treated as active
    "ACTIVE",
    " active",             // whitespace variant must NOT pass
    "active ",
    "some_future_status",  // arbitrary unknown string Circle could add later
    "",                    // empty string
    null,
    0,
    true,
  ];

  for (const status of NON_ACTIVE_STATUSES) {
    it(`returns authorized: false for status: ${JSON.stringify(status)}`, async () => {
      const getUserAuthInfo = createGetUserAuthInfo(
        async () => MEMBER_CLERK_USER,
        makeFetchMock(200, { id: 42, community_member_id: 1234, status }),
      );
      const result = await getUserAuthInfo(MEMBER_USER_ID);
      assert.equal(
        result.authorized,
        false,
        `Member record with status ${JSON.stringify(status)} must be denied — only exactly "active" is authorized`,
      );
    });
  }

  it('returns authorized: true ONLY for the exact string "active" (control)', async () => {
    const getUserAuthInfo = createGetUserAuthInfo(
      async () => MEMBER_CLERK_USER,
      makeFetchMock(200, { id: 42, community_member_id: 1234, status: "active" }),
    );
    const result = await getUserAuthInfo(MEMBER_USER_ID);
    assert.equal(result.authorized, true, 'Exact status "active" must remain authorized');
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

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 4 — Clerk JWT token expiry
//
// When a Clerk JWT expires mid-session and the client-side auto-refresh fails
// (e.g. the user is offline or the refresh token has itself expired), Clerk's
// server-side SDK sets userId to null.  The requireAuth middleware must return
// HTTP 401 immediately — not a silent empty response and not a 500 — so the
// frontend can detect the 401 and send the user to the sign-in page.
// ═══════════════════════════════════════════════════════════════════════════════

describe("requireAuth middleware — expired/invalid Clerk JWT (userId is null)", () => {
  /**
   * This scenario is identical to "unauthenticated request" from the Clerk
   * middleware's perspective: getAuth(req).userId is null whether the request
   * has no session at all or whether the JWT is present but has expired and
   * the refresh failed.  The middleware must treat both the same way.
   */
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());

    // Simulate what clerkMiddleware sets when a token is expired/unverifiable:
    // getAuth() returns { userId: null }.
    const mw = createRequireAuth(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null), // null userId — token present but expired / invalid
    );
    app.get("/protected", mw, (_req, res) => res.json({ ok: true }));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 401 — not a silent 200 or a 500", async () => {
    const res = await fetch(`${ts.url}/protected`);
    assert.equal(
      res.status,
      401,
      `Expired-token request must receive 401, got ${res.status}`,
    );
  });

  it("response body contains an error field so the caller knows what failed", async () => {
    const res = await fetch(`${ts.url}/protected`);
    const body = (await res.json()) as { error: string };
    assert.ok(
      typeof body.error === "string" && body.error.length > 0,
      `401 body must have a non-empty error string (got: ${JSON.stringify(body)})`,
    );
  });

  it("does NOT reach the protected route handler", async () => {
    const res = await fetch(`${ts.url}/protected`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(
      body["ok"] !== true,
      "Route handler must not execute when the Clerk token is expired",
    );
  });

  it("response body does not leak internal session detail", async () => {
    const res = await fetch(`${ts.url}/protected`);
    const text = await res.text();
    // Must not expose any token, userId, or internal stack trace
    assert.ok(
      !text.includes("userId") && !text.includes("stack"),
      `401 body must not expose internal session detail (got: ${text.slice(0, 200)})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 0 — POST /auth/preflight rate limiting
//
// The preflight endpoint is fully public, so without a rate limit a script
// could enumerate Circle membership for arbitrary emails.  These tests confirm
// that the injected rate limiter fires correctly.
//
// Each describe block gets its own Express app + rate-limiter instance so
// the counters are isolated and tests don't interfere with each other.
// The limiter is created with max=3 so tests run without waiting for long
// real-time windows.  `getIp` is stubbed to a fixed string so every request
// in the same suite counts toward the same bucket.
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /auth/preflight — rate limiter: first N requests are allowed", () => {
  const MAX = 3;
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: MAX,
      getIp: () => "test-ip-allow",
    });
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      async () => false,
      limiter,
    ));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it(`none of the first ${MAX} requests return 429`, async () => {
    for (let i = 1; i <= MAX; i++) {
      const res = await fetch(`${ts.url}/api/auth/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
      });
      assert.notEqual(
        res.status,
        429,
        `Request ${i}/${MAX} must not be rate-limited`,
      );
    }
  });
});

describe("POST /auth/preflight — rate limiter: (N+1)th request returns 429", () => {
  const MAX = 3;
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: MAX,
      getIp: () => "test-ip-block",
    });
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      async () => false,
      limiter,
    ));
    ts = await startServer(app);

    // Exhaust the quota so subsequent requests in the tests are over-limit
    for (let i = 0; i < MAX; i++) {
      await fetch(`${ts.url}/api/auth/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
      });
    }
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 429 on the over-limit request", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    assert.equal(
      res.status,
      429,
      `Expected 429 on request ${MAX + 1}, got ${res.status}`,
    );
  });

  it("429 response includes a Retry-After header with a positive integer value", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    const retryAfter = res.headers.get("Retry-After");
    assert.ok(
      retryAfter !== null && Number.isInteger(Number(retryAfter)) && Number(retryAfter) > 0,
      `Retry-After header must be a positive integer (got: ${retryAfter})`,
    );
  });

  it("429 response body contains an error field", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    const body = (await res.json()) as { error: string };
    assert.ok(
      typeof body.error === "string" && body.error.length > 0,
      "429 body must include a non-empty error field",
    );
  });
});

describe("POST /auth/preflight — rate limiter: different IPs have independent quotas", () => {
  const MAX = 2;
  let ts: TestServer;
  let currentIp: string;

  before(async () => {
    currentIp = "ip-a";
    const app = express();
    app.use(express.json());
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: MAX,
      getIp: () => currentIp,
    });
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      async () => false,
      limiter,
    ));
    ts = await startServer(app);

    // Exhaust ip-a's quota
    for (let i = 0; i < MAX; i++) {
      await fetch(`${ts.url}/api/auth/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
      });
    }
  });
  after(() => stopServer(ts.server));

  it("ip-a is rate-limited after exhausting its quota", async () => {
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    assert.equal(res.status, 429, `ip-a should be rate-limited, got ${res.status}`);
  });

  it("ip-b is NOT rate-limited (fresh quota)", async () => {
    currentIp = "ip-b"; // switch to a different IP
    const res = await fetch(`${ts.url}/api/auth/preflight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
    });
    assert.notEqual(
      res.status,
      429,
      `ip-b must have its own fresh quota and must not be rate-limited (got ${res.status})`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// checkEmailMembership unit tests — lib level
//
// These tests exercise the actual checkEmailMembership function from
// circle-membership.ts (the function the preflight route calls) rather than
// injecting a stub at the router level.  This confirms that the throw
// propagates correctly from the fetch layer all the way up to the caller,
// so the preflight handler can catch it and return 503.
// ═══════════════════════════════════════════════════════════════════════════════

describe("checkEmailMembership — network timeout throws so the caller can return 503", () => {
  let restore: () => void;

  before(() => { restore = withCircleEnv(); });
  after(() => { restore(); });

  it("throws when the fetch call raises a network error (AbortError / connection refused)", async () => {
    const throwingFetch = makeThrowingFetchMock();
    await assert.rejects(
      () => checkEmailMembership(MEMBER_EMAIL, throwingFetch),
      /Network timeout/,
      "checkEmailMembership must propagate the network error so the caller can return 503",
    );
  });

  it("does NOT return false silently on network failure — it always throws", async () => {
    const throwingFetch = makeThrowingFetchMock();
    let threw = false;
    try {
      await checkEmailMembership(MEMBER_EMAIL, throwingFetch);
    } catch {
      threw = true;
    }
    assert.ok(
      threw,
      "checkEmailMembership must throw on network failure (not swallow it and return false)",
    );
  });
});

describe("checkEmailMembership — Circle returns 500: throws so the caller can return 503", () => {
  let restore: () => void;

  before(() => { restore = withCircleEnv(); });
  after(() => { restore(); });

  it("throws when Circle responds with HTTP 500", async () => {
    const errorFetch = makeFetchMock(500, { message: "Internal Server Error" });
    await assert.rejects(
      () => checkEmailMembership(MEMBER_EMAIL, errorFetch),
      (err: unknown) => err instanceof Error && /unexpected status 500/.test((err as Error).message),
      "checkEmailMembership must throw on a 5xx from Circle so the caller can distinguish it from a denial",
    );
  });

  it("does NOT return false silently on a 5xx — it always throws", async () => {
    const errorFetch = makeFetchMock(500, { message: "Internal Server Error" });
    let threw = false;
    try {
      await checkEmailMembership(MEMBER_EMAIL, errorFetch);
    } catch {
      threw = true;
    }
    assert.ok(
      threw,
      "checkEmailMembership must throw on 5xx (not return false), so the preflight route can return 503",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// End-to-end: preflight route wired with the real checkEmailMembership + fetch mock
//
// These tests wire the router with a thin wrapper around the real
// checkEmailMembership so the full call chain (router → checkEmailMembership →
// checkCircleMembership → fetch mock) is exercised.  This is the closest
// simulation of a real Circle outage without hitting the live API.
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /auth/preflight — Circle network timeout via real checkEmailMembership: returns 503 not 403", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    // Inject the real checkEmailMembership wired to a throwing fetch.
    // This exercises the full path: router → checkEmailMembership → throw → 503.
    const throwingFetch = makeThrowingFetchMock();
    const checkMembership = (email: string) => checkEmailMembership(email, throwingFetch);
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      checkMembership,
      noopLimiter,
    ));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 503 (not 200 or 403) when Circle is unreachable", async () => {
    const restore = withCircleEnv();
    try {
      const res = await fetch(`${ts.url}/api/auth/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: MEMBER_EMAIL }),
      });
      assert.equal(
        res.status,
        503,
        `Expected 503 when Circle is unreachable, got ${res.status} — frontend must show 'try again', not 'not authorized'`,
      );
    } finally {
      restore();
    }
  });

  it("response body contains error: circle_unavailable (not authorized: false)", async () => {
    const restore = withCircleEnv();
    try {
      const res = await fetch(`${ts.url}/api/auth/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: MEMBER_EMAIL }),
      });
      const body = (await res.json()) as { error?: string; authorized?: boolean };
      assert.equal(
        body.error,
        "circle_unavailable",
        `Body must carry error:'circle_unavailable' (got: ${JSON.stringify(body)})`,
      );
      assert.ok(
        !("authorized" in body),
        "Body must NOT have an 'authorized' field when Circle is unreachable — that field is only for membership decisions",
      );
    } finally {
      restore();
    }
  });
});

describe("POST /auth/preflight — Circle returns 500 via real checkEmailMembership: returns 503 not 403", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    const errorFetch = makeFetchMock(500, { message: "Internal Server Error" });
    const checkMembership = (email: string) => checkEmailMembership(email, errorFetch);
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      checkMembership,
      noopLimiter,
    ));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 503 when Circle itself returns 500", async () => {
    const restore = withCircleEnv();
    try {
      const res = await fetch(`${ts.url}/api/auth/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: MEMBER_EMAIL }),
      });
      assert.equal(
        res.status,
        503,
        `Expected 503 when Circle returns 500, got ${res.status}`,
      );
    } finally {
      restore();
    }
  });

  it("body error is circle_unavailable when Circle returns 500", async () => {
    const restore = withCircleEnv();
    try {
      const res = await fetch(`${ts.url}/api/auth/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: MEMBER_EMAIL }),
      });
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "circle_unavailable");
    } finally {
      restore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Regression: genuine non-member still gets authorized:false — not 503
//
// Confirms there is no regression where a reachable-but-denying Circle API
// is confused with an unreachable Circle API.  A non-member must always see
// HTTP 200 / authorized:false so the frontend shows "email not authorized",
// never "try again".
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /auth/preflight — regression: genuine non-member gets 200/authorized:false, not 503", () => {
  let ts: TestServer;

  before(async () => {
    const app = express();
    app.use(express.json());
    // Circle responds 404 — the canonical "not a member" response.
    const notMemberFetch = makeFetchMock(404, { message: "Not Found" });
    const checkMembership = (email: string) => checkEmailMembership(email, notMemberFetch);
    app.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      checkMembership,
      noopLimiter,
    ));
    ts = await startServer(app);
  });
  after(() => stopServer(ts.server));

  it("returns HTTP 200 (not 503) for a non-member when Circle is reachable", async () => {
    const restore = withCircleEnv();
    try {
      const res = await fetch(`${ts.url}/api/auth/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
      });
      assert.equal(
        res.status,
        200,
        `Non-member with reachable Circle must get 200, got ${res.status} — a 503 would wrongly tell them to 'try again'`,
      );
    } finally {
      restore();
    }
  });

  it("body has authorized:false (not error:circle_unavailable) for a genuine non-member", async () => {
    const restore = withCircleEnv();
    try {
      const res = await fetch(`${ts.url}/api/auth/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
      });
      const body = (await res.json()) as { authorized?: boolean; error?: string };
      assert.equal(
        body.authorized,
        false,
        "Non-member must see authorized:false — not an error code that implies a temporary failure",
      );
      assert.ok(
        !("error" in body) || body.error !== "circle_unavailable",
        "Non-member response must not carry error:'circle_unavailable'",
      );
    } finally {
      restore();
    }
  });

  it("a 200/authorized:false response with an empty-array Circle reply is also a non-member (not 503)", async () => {
    // Circle 200 + [] is the other 'not a member' variant (as opposed to 404).
    const restore = withCircleEnv();
    const emptyArrayFetch = makeFetchMock(200, []);
    const checkMembership = (email: string) => checkEmailMembership(email, emptyArrayFetch);

    const app2 = express();
    app2.use(express.json());
    app2.use("/api", createAuthStatusRouter(
      async () => ({ email: "", authorized: false }),
      makeGetAuth(null),
      checkMembership,
      noopLimiter,
    ));
    const ts2 = await startServer(app2);
    try {
      const res = await fetch(`${ts2.url}/api/auth/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: NON_MEMBER_EMAIL }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { authorized: boolean };
      assert.equal(body.authorized, false, "Empty-array Circle reply must produce authorized:false, not 503");
    } finally {
      restore();
      await stopServer(ts2.server);
    }
  });
});
