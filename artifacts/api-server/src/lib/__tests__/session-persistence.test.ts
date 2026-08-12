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

  app.use(
    session({
      store: makeStore(),
      secret: TEST_SECRET,
      name: COOKIE_NAME,
      resave: false,
      saveUninitialized: false,
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
});
