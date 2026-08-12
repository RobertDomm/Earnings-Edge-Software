/**
 * session-persistence.test.ts
 *
 * Integration test: confirms that a session cookie issued by one Express
 * process is still accepted after a full in-memory restart, simulating a
 * cold autoscale instance or a container restart picking up an existing
 * browser session.
 *
 * How it works
 * ────────────
 * 1. Build and start Server A (fresh in-memory state, PostgreSQL session store).
 * 2. POST to /test-login — creates a real session row in PostgreSQL and returns
 *    a Set-Cookie header.
 * 3. Close Server A completely (all in-memory session cache is gone).
 * 4. Build and start Server B (brand-new Express app, same PostgreSQL store,
 *    same session secret — same as a real autoscale instance).
 * 5. GET /test-status on Server B, forwarding the original cookie.
 * 6. Assert: authenticated === true (session was read from PostgreSQL, not RAM).
 * 7. Sanity-checks: forged and missing cookies both return authenticated false.
 *
 * Prerequisites
 * ─────────────
 * DATABASE_URL must be set (Replit provides this automatically).
 * No SESSION_SECRET env var is needed — the test supplies its own fixed secret.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type RequestHandler } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
// Use the workspace DB package — it already depends on pg and exports the pool.
import { pool as sharedPool } from "@workspace/db";
// Real auth router — tests the production logout path, not a synthetic clone.
import authRouter from "../../routes/auth.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Fixed secret used by every test server — same as what would be in Replit Secrets. */
const TEST_SECRET = "test-session-secret-for-ci-only";

/** Session cookie name must match the real app so tests stay realistic. */
const COOKIE_NAME = "screener.sid";

/** User data written into the session on login. */
const MOCK_USER = {
  userId: "test-user-001",
  user: { id: "test-user-001", name: "Test User", email: "test@example.com" },
  authorizedAt: Date.now(),
  lastRevalidatedAt: Date.now(),
};

// ─── Session store factory ────────────────────────────────────────────────────
//
// Each call returns a *fresh* connect-pg-simple store instance backed by the
// shared PostgreSQL pool.  A fresh store object simulates a new process because
// it starts with no in-memory session cache — the session must be loaded from
// PostgreSQL.

const PgSession = connectPgSimple(session);

function makeStore(): connectPgSimple.PGStore {
  return new PgSession({
    pool: sharedPool,
    // The session table is created by the production startup migration.
    // Tests assume the schema already exists (true in any environment that
    // has run the API server at least once).  The before() hook below also
    // creates it idempotently in case the test DB is fresh.
    createTableIfMissing: false,
    // Disable automatic pruning — test sessions are cleaned up by afterEach.
    pruneSessionInterval: false,
  });
}

// ─── Test Express app factory ─────────────────────────────────────────────────
//
// Each call builds an entirely fresh Express app (no shared module-level
// state beyond the DB pool), which is the key property this test verifies:
// two independent process images reading from the same PostgreSQL store.

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());

  // The real auth router calls req.log (pino per-request logger).
  // Attach a no-op stub so the router works without pino-http in tests.
  app.use((req, _res, next) => {
    (req as any).log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    next();
  });

  app.use(
    session({
      store: makeStore(),
      secret: TEST_SECRET,
      name: COOKIE_NAME,
      resave: false,
      saveUninitialized: false,
      // Mirror the production setting: roll the cookie expiry forward on every
      // authenticated response so active users are never silently ejected.
      rolling: true,
      cookie: {
        httpOnly: true,
        // Tests run over plain HTTP (127.0.0.1), so secure must be false.
        // The real server uses secure: true because Replit proxies HTTPS.
        secure: false,
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000,
      },
    }),
  );

  // POST /test-login — writes session.auth and persists it to PostgreSQL.
  const loginHandler: RequestHandler = (req, res) => {
    (req.session as any).auth = MOCK_USER;
    req.session.save((err) => {
      if (err) {
        res.status(500).json({ error: String(err) });
        return;
      }
      res.json({ ok: true, sessionId: req.session.id });
    });
  };
  app.post("/test-login", loginHandler);

  // GET /test-status — returns whether session.auth is present.
  const statusHandler: RequestHandler = (req, res) => {
    const auth = (req.session as any).auth;
    res.json({
      authenticated: Boolean(auth),
      userId: auth?.userId ?? null,
    });
  };
  app.get("/test-status", statusHandler);

  // Mount the real auth router so the logout test exercises the production
  // logout path (session.destroy awaited before success response).
  app.use("/", authRouter);

  return app;
}

// ─── Server lifecycle helpers ─────────────────────────────────────────────────

interface TestServer {
  url: string;
  server: Server;
}

function startServer(): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const app = buildApp();
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Cannot determine server address"));
        return;
      }
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
    server.on("error", reject);
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

/**
 * Parse a raw Set-Cookie header value and return just the cookie key=value
 * pair (without attributes like Path, HttpOnly, etc.), ready to send as a
 * Cookie request header.
 */
function extractCookieValue(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error("No Set-Cookie header in response");
  // The first segment (before the first ";") is the key=value pair.
  return setCookieHeader.split(";")[0].trim();
}

/**
 * Parse the Expires attribute from a raw Set-Cookie header and return its
 * value as a Unix timestamp (ms).  express-session emits an absolute Expires
 * date string rather than Max-Age when the cookie object carries a `maxAge`.
 * Returns null if the attribute is absent or unparseable.
 */
function extractCookieExpires(setCookieHeader: string | null): number | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/[;,]\s*Expires=([^;]+)/i);
  if (!match) return null;
  const ts = Date.parse(match[1].trim());
  return isNaN(ts) ? null : ts;
}

// ─── Test state ───────────────────────────────────────────────────────────────

/** Session IDs created during tests so afterEach can clean them up. */
const sessionIdsToCleanup: string[] = [];

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Session persistence across server restarts", () => {
  // Ensure the session table exists before running any tests.
  // This is idempotent — it is a no-op if the table already exists.
  before(async () => {
    await sharedPool.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid"    varchar      NOT NULL COLLATE "default",
        "sess"   json         NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
      )
    `);
    await sharedPool.query(`
      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire")
    `);
  });

  // Remove any sessions inserted during each test so the suite is side-effect-free.
  afterEach(async () => {
    if (sessionIdsToCleanup.length > 0) {
      await sharedPool.query(
        `DELETE FROM "session" WHERE sid = ANY($1::text[])`,
        [sessionIdsToCleanup],
      );
      sessionIdsToCleanup.length = 0;
    }
  });

  // ── Core scenario ─────────────────────────────────────────────────────────

  it("a session cookie issued by Server A is accepted by fresh Server B", async () => {
    // ── Step 1: Start Server A and log in ──────────────────────────────────
    const serverA = await startServer();

    const loginRes = await fetch(`${serverA.url}/test-login`, {
      method: "POST",
    });
    assert.equal(
      loginRes.status,
      200,
      `Login on Server A must return 200 (got ${loginRes.status})`,
    );

    const loginBody = (await loginRes.json()) as {
      ok: boolean;
      sessionId: string;
    };
    const sessionId = loginBody.sessionId;
    sessionIdsToCleanup.push(sessionId);

    const setCookieHeader = loginRes.headers.get("set-cookie");
    const cookieValue = extractCookieValue(setCookieHeader);

    assert.ok(
      cookieValue.startsWith(`${COOKIE_NAME}=`),
      `Set-Cookie must begin with "${COOKIE_NAME}=" (got: ${cookieValue})`,
    );

    // ── Step 2: Stop Server A (discard all in-memory state) ───────────────
    await stopServer(serverA.server);

    // ── Step 3: Start Server B (entirely fresh Express instance) ──────────
    // This simulates a cold autoscale instance: no warm session cache,
    // no knowledge of what Server A did — only the shared PostgreSQL store.
    const serverB = await startServer();

    // ── Step 4: Replay the original cookie on Server B ────────────────────
    const statusRes = await fetch(`${serverB.url}/test-status`, {
      headers: { Cookie: cookieValue },
    });
    assert.equal(
      statusRes.status,
      200,
      `Status check on Server B must return 200 (got ${statusRes.status})`,
    );

    const statusBody = (await statusRes.json()) as {
      authenticated: boolean;
      userId: string | null;
    };

    // ── Step 5: Assert the session is still authenticated ─────────────────
    assert.equal(
      statusBody.authenticated,
      true,
      "Session must be authenticated on Server B after Server A restart " +
        `(userId: ${statusBody.userId}, authenticated: ${statusBody.authenticated})`,
    );

    assert.equal(
      statusBody.userId,
      MOCK_USER.userId,
      `Session userId must match the logged-in user (got ${statusBody.userId})`,
    );

    await stopServer(serverB.server);
  });

  // ── Sanity check: forged cookie is rejected ───────────────────────────────

  it("a forged / random session cookie returns authenticated false", async () => {
    const server = await startServer();

    const statusRes = await fetch(`${server.url}/test-status`, {
      headers: { Cookie: `${COOKIE_NAME}=s%3Anot-a-real-session.forged-sig` },
    });
    assert.equal(
      statusRes.status,
      200,
      `Status route must return 200 even for unknown cookies (got ${statusRes.status})`,
    );

    const body = (await statusRes.json()) as { authenticated: boolean };
    assert.equal(
      body.authenticated,
      false,
      "A forged cookie must not produce an authenticated session",
    );

    await stopServer(server.server);
  });

  // ── Sanity check: missing cookie is not authenticated ────────────────────

  it("a request with no cookie returns authenticated false", async () => {
    const server = await startServer();

    const statusRes = await fetch(`${server.url}/test-status`);
    const body = (await statusRes.json()) as { authenticated: boolean };

    assert.equal(
      body.authenticated,
      false,
      "A request with no session cookie must not be authenticated",
    );

    await stopServer(server.server);
  });

  // ── Logout invalidates the session immediately ────────────────────────────
  //
  // Steps:
  // 1. Log in on Server A — get a signed cookie and a session row in PostgreSQL.
  // 2. Log out on Server A — session.destroy() must delete the row.
  // 3. Stop Server A (discard all in-memory state).
  // 4. Start Server B — a fresh process with no warm session cache.
  // 5. Replay the original cookie on Server B.
  // 6. Assert authenticated: false — the row is gone from PostgreSQL.

  it("replayed cookie after logout returns authenticated false, even on a fresh server instance", async () => {
    // ── Step 1: Log in ────────────────────────────────────────────────────
    const serverA = await startServer();

    const loginRes = await fetch(`${serverA.url}/test-login`, {
      method: "POST",
    });
    assert.equal(
      loginRes.status,
      200,
      `Login must return 200 (got ${loginRes.status})`,
    );

    const loginBody = (await loginRes.json()) as {
      ok: boolean;
      sessionId: string;
    };
    const sessionId = loginBody.sessionId;
    sessionIdsToCleanup.push(sessionId);

    const cookieValue = extractCookieValue(loginRes.headers.get("set-cookie"));

    // Confirm the session is live before logout.
    const preLogoutRes = await fetch(`${serverA.url}/test-status`, {
      headers: { Cookie: cookieValue },
    });
    const preLogoutBody = (await preLogoutRes.json()) as {
      authenticated: boolean;
    };
    assert.equal(
      preLogoutBody.authenticated,
      true,
      "Session must be authenticated before logout",
    );

    // ── Step 2: Log out via the real production route ─────────────────────
    // POST /auth/logout (the actual handler) awaits session.destroy before
    // returning { success: true }, so when this fetch resolves the session
    // row is guaranteed to be gone from PostgreSQL.
    const logoutRes = await fetch(`${serverA.url}/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookieValue },
    });
    assert.equal(
      logoutRes.status,
      200,
      `Logout must return 200 (got ${logoutRes.status})`,
    );
    const logoutBody = (await logoutRes.json()) as { success: boolean };
    assert.equal(
      logoutBody.success,
      true,
      "Real logout route must respond with { success: true }",
    );

    // ── Step 3: Stop Server A (all in-memory state is gone) ───────────────
    await stopServer(serverA.server);

    // ── Step 4: Start Server B (fresh process, no session cache) ──────────
    const serverB = await startServer();

    // ── Step 5: Replay the original cookie on Server B ────────────────────
    const replayRes = await fetch(`${serverB.url}/test-status`, {
      headers: { Cookie: cookieValue },
    });
    assert.equal(
      replayRes.status,
      200,
      `Status route must return 200 even for a logged-out cookie (got ${replayRes.status})`,
    );

    // ── Step 6: Assert the replayed cookie is rejected ────────────────────
    const replayBody = (await replayRes.json()) as {
      authenticated: boolean;
      userId: string | null;
    };
    assert.equal(
      replayBody.authenticated,
      false,
      "A cookie replayed after logout must not be authenticated " +
        `(userId: ${replayBody.userId}, authenticated: ${replayBody.authenticated})`,
    );

    await stopServer(serverB.server);
  });

  // ── Expired session is rejected ───────────────────────────────────────────
  //
  // Steps:
  // 1. Log in through the test server to get a real, properly-signed cookie.
  // 2. Back-date the session row's expire column to a timestamp in the past.
  // 3. Replay the cookie against a fresh server instance.
  // 4. Assert that the response returns authenticated: false.
  //
  // connect-pg-simple only returns a session row when its expire column is
  // still in the future, so this test exercises the enforcement path without
  // needing to hand-craft signed cookies.

  it("an expired session cookie returns authenticated false", async () => {
    // ── Step 1: Log in to obtain a real session id and signed cookie ──────
    const serverA = await startServer();

    const loginRes = await fetch(`${serverA.url}/test-login`, {
      method: "POST",
    });
    assert.equal(
      loginRes.status,
      200,
      `Login must return 200 (got ${loginRes.status})`,
    );

    const loginBody = (await loginRes.json()) as {
      ok: boolean;
      sessionId: string;
    };
    const sessionId = loginBody.sessionId;
    sessionIdsToCleanup.push(sessionId);

    const cookieValue = extractCookieValue(loginRes.headers.get("set-cookie"));

    // Confirm the session is currently valid before we expire it.
    const preCheckRes = await fetch(`${serverA.url}/test-status`, {
      headers: { Cookie: cookieValue },
    });
    const preCheckBody = (await preCheckRes.json()) as {
      authenticated: boolean;
    };
    assert.equal(
      preCheckBody.authenticated,
      true,
      "Session must be authenticated before expiry manipulation",
    );

    await stopServer(serverA.server);

    // ── Step 2: Back-date the expire column to a timestamp in the past ────
    // Use the raw session id (without the "sess:" prefix) as stored by
    // connect-pg-simple — which is exactly what req.session.id returns.
    await sharedPool.query(
      `UPDATE "session" SET expire = NOW() - INTERVAL '1 minute' WHERE sid = $1`,
      [sessionId],
    );

    // ── Step 3: Replay the cookie against a fresh server ─────────────────
    const serverB = await startServer();

    const expiredRes = await fetch(`${serverB.url}/test-status`, {
      headers: { Cookie: cookieValue },
    });
    assert.equal(
      expiredRes.status,
      200,
      `Status route must return 200 even for expired sessions (got ${expiredRes.status})`,
    );

    // ── Step 4: Assert the session is no longer authenticated ─────────────
    const expiredBody = (await expiredRes.json()) as {
      authenticated: boolean;
      userId: string | null;
    };
    assert.equal(
      expiredBody.authenticated,
      false,
      "An expired session must not be accepted as authenticated " +
        `(userId: ${expiredBody.userId}, authenticated: ${expiredBody.authenticated})`,
    );

    await stopServer(serverB.server);
  });

  // ── Rolling expiry: active sessions get their expiry extended ─────────────
  //
  // What this proves
  // ─────────────────
  // `rolling: true` in express-session must do two things on every authenticated
  // response:
  //   a) Re-emit a Set-Cookie header with a fresh Max-Age so the browser cookie
  //      is also extended (not just the server-side row).
  //   b) Call the store's touch() to push the PostgreSQL `expire` column forward.
  //
  // Both are required: without (a) the browser discards the cookie after the
  // original 24 h window even though the server would still accept it.
  //
  // Steps
  // ──────
  // 1. Log in — record the wall-clock time and read the initial DB expire.
  // 2. Wait >1 s so connect-pg-simple's touch() threshold is met.
  // 3. Send another authenticated request.
  // 4. Assert the activity response carries a Set-Cookie header for screener.sid
  //    with a Max-Age equal to the configured maxAge (i.e. the cookie was
  //    re-issued, not just left alone).
  // 5. Assert the PostgreSQL expire column has also advanced (store touch).

  it("rolling: true re-issues the Set-Cookie header and extends the DB expire on each active request", async () => {
    // ── Step 1: Log in ────────────────────────────────────────────────────
    const server = await startServer();

    const loginRes = await fetch(`${server.url}/test-login`, {
      method: "POST",
    });
    assert.equal(
      loginRes.status,
      200,
      `Login must return 200 (got ${loginRes.status})`,
    );

    const loginBody = (await loginRes.json()) as {
      ok: boolean;
      sessionId: string;
    };
    const sessionId = loginBody.sessionId;
    sessionIdsToCleanup.push(sessionId);

    const loginSetCookie = loginRes.headers.get("set-cookie");
    const cookieValue = extractCookieValue(loginSetCookie);

    // Record the Expires timestamp from the login cookie for later comparison.
    const loginCookieExpires = extractCookieExpires(loginSetCookie);
    assert.ok(
      loginCookieExpires !== null && loginCookieExpires > Date.now(),
      `Login Set-Cookie must carry a future Expires attribute ` +
        `(got: ${loginSetCookie})`,
    );

    // Read the initial DB expire timestamp for later comparison.
    const before = await sharedPool.query<{ expire: Date }>(
      `SELECT expire FROM "session" WHERE sid = $1`,
      [sessionId],
    );
    assert.equal(
      before.rows.length,
      1,
      "Session row must exist in PostgreSQL after login",
    );
    const expireBefore = before.rows[0].expire.getTime();

    // ── Step 2: Wait so connect-pg-simple's touch() threshold is met ──────
    // connect-pg-simple skips touch() when the stored expiry is already
    // within one TTL window (i.e. within one second for sub-second maxAges).
    // With maxAge=24h it only touches when the new expiry would be > 1 s
    // later than the stored value, so a 1.1 s delay is sufficient.
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));

    // ── Step 3: Send an authenticated activity request ─────────────────────
    const activityRes = await fetch(`${server.url}/test-status`, {
      headers: { Cookie: cookieValue },
    });
    assert.equal(
      activityRes.status,
      200,
      `Activity request must return 200 (got ${activityRes.status})`,
    );

    const activityBody = (await activityRes.json()) as {
      authenticated: boolean;
    };
    assert.equal(
      activityBody.authenticated,
      true,
      "Session must still be authenticated during the rolling check",
    );

    // ── Step 4: Assert the response re-issued the Set-Cookie header ────────
    // `rolling: true` must cause every authenticated response to emit a
    // refreshed Set-Cookie so the browser's cookie lifetime is also extended.
    // express-session emits an absolute Expires date (not Max-Age) when the
    // cookie object carries a maxAge value.
    const activitySetCookie = activityRes.headers.get("set-cookie");
    assert.ok(
      activitySetCookie !== null &&
        activitySetCookie.startsWith(`${COOKIE_NAME}=`),
      `Activity response must emit a Set-Cookie for ${COOKIE_NAME} ` +
        `(rolling: true is required). Got: ${activitySetCookie}`,
    );

    // The refreshed cookie must carry an Expires timestamp that is strictly
    // later than the one on the original login cookie — proving rolling advanced
    // the browser-side lifetime, not just re-sent the same expiry.
    const activityCookieExpires = extractCookieExpires(activitySetCookie);
    assert.ok(
      activityCookieExpires !== null,
      `Set-Cookie from activity response must include an Expires attribute ` +
        `(got: ${activitySetCookie})`,
    );
    assert.ok(
      activityCookieExpires! > loginCookieExpires!,
      `Rolled cookie Expires must be strictly later than the login cookie Expires ` +
        `(login: ${new Date(loginCookieExpires!).toISOString()}, ` +
        `activity: ${new Date(activityCookieExpires!).toISOString()})`,
    );

    // ── Step 5: Assert the PostgreSQL expire column has advanced ──────────
    const after = await sharedPool.query<{ expire: Date }>(
      `SELECT expire FROM "session" WHERE sid = $1`,
      [sessionId],
    );
    assert.equal(
      after.rows.length,
      1,
      "Session row must still exist after the activity request",
    );
    const expireAfter = after.rows[0].expire.getTime();

    assert.ok(
      expireAfter > expireBefore,
      `PostgreSQL expire must advance after an active request ` +
        `(before: ${new Date(expireBefore).toISOString()}, ` +
        `after: ${new Date(expireAfter).toISOString()})`,
    );

    await stopServer(server.server);
  });

  // ── Server-side session revocation: deleted row is rejected ──────────────
  //
  // What this proves
  // ─────────────────
  // An admin action, account deletion, or forced sign-out from a separate
  // device may remove the session row directly from PostgreSQL while the
  // browser still holds the signed cookie. connect-pg-simple must treat a
  // missing row as unauthenticated rather than silently passing the request
  // through.
  //
  // Steps
  // ──────
  // 1. Log in to obtain a valid signed cookie and a session row in PostgreSQL.
  // 2. Delete the session row directly from the `session` table (server-side
  //    revocation — the browser cookie is untouched).
  // 3. Confirm the row is absent.
  // 4. Start a fresh server instance (no in-memory session cache).
  // 5. Replay the original cookie.
  // 6. Assert authenticated: false — the missing row must not be treated as valid.
  // Cleanup is idempotent: afterEach DELETE on a non-existent row is a no-op.

  it("replaying a cookie whose session row was deleted returns authenticated false", async () => {
    // ── Step 1: Log in to get a valid session cookie ──────────────────────
    const serverA = await startServer();

    const loginRes = await fetch(`${serverA.url}/test-login`, {
      method: "POST",
    });
    assert.equal(
      loginRes.status,
      200,
      `Login must return 200 (got ${loginRes.status})`,
    );

    const loginBody = (await loginRes.json()) as {
      ok: boolean;
      sessionId: string;
    };
    const sessionId = loginBody.sessionId;

    // Register for cleanup. afterEach will attempt DELETE on this id —
    // safe because the row will already be gone and DELETE on a missing
    // row is a no-op in PostgreSQL.
    sessionIdsToCleanup.push(sessionId);

    const cookieValue = extractCookieValue(loginRes.headers.get("set-cookie"));

    // Confirm the session is authenticated before revocation.
    const preRevokeRes = await fetch(`${serverA.url}/test-status`, {
      headers: { Cookie: cookieValue },
    });
    const preRevokeBody = (await preRevokeRes.json()) as {
      authenticated: boolean;
    };
    assert.equal(
      preRevokeBody.authenticated,
      true,
      "Session must be authenticated before the row is deleted",
    );

    // ── Step 2: Delete the session row directly from PostgreSQL ───────────
    // Simulates server-side revocation (admin action, account deletion, or
    // forced sign-out from another device). The browser cookie is untouched.
    await sharedPool.query(`DELETE FROM "session" WHERE sid = $1`, [sessionId]);

    // ── Step 3: Confirm the row is absent ─────────────────────────────────
    const checkRes = await sharedPool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM "session" WHERE sid = $1`,
      [sessionId],
    );
    assert.equal(
      checkRes.rows[0].count,
      "0",
      "Session row must be absent from PostgreSQL after direct DELETE",
    );

    // ── Step 4: Stop Server A and start a fresh Server B ─────────────────
    // A fresh server has no in-memory session cache so it must go to
    // PostgreSQL — where the row no longer exists.
    await stopServer(serverA.server);
    const serverB = await startServer();

    // ── Step 5: Replay the original cookie on Server B ────────────────────
    const replayRes = await fetch(`${serverB.url}/test-status`, {
      headers: { Cookie: cookieValue },
    });
    assert.equal(
      replayRes.status,
      200,
      `Status route must return 200 even when the session row is gone (got ${replayRes.status})`,
    );

    // ── Step 6: Assert the replayed cookie is rejected ────────────────────
    const replayBody = (await replayRes.json()) as {
      authenticated: boolean;
      userId: string | null;
    };
    assert.equal(
      replayBody.authenticated,
      false,
      "A cookie whose session row was deleted must not be authenticated " +
        `(userId: ${replayBody.userId}, authenticated: ${replayBody.authenticated})`,
    );

    await stopServer(serverB.server);
  });
});
