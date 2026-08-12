/**
 * scanner-persistence.test.ts
 *
 * Integration test: confirms that scan results written to PostgreSQL by one
 * logical "instance" (router A) are visible to a completely fresh router
 * instance (router B) with no shared in-memory state.
 *
 * This guards against regressions that would silently revert GET /scanner/results
 * to reading from a local cache instead of the database, which would cause cold
 * autoscale instances to return empty results for users.
 *
 * How it works
 * ────────────
 * 1. Delete any pre-existing scanner_results row so each test starts clean.
 * 2. Write a complete scan result directly to PostgreSQL using the shared pool
 *    (this simulates "Instance A" finishing a background scan).
 * 3. Build a brand-new Express app + Router (simulating "Instance B" — a fresh
 *    cold-start with zero in-memory knowledge of the previous write).
 * 4. Call GET /scanner/results on Instance B.
 * 5. Assert the response reflects the data written in step 2.
 * 6. Repeat the pattern for the upsert path: write again and confirm the second
 *    write overwrites the first.
 *
 * Prerequisites
 * ─────────────
 * DATABASE_URL must be set (Replit provides this automatically).
 * No SESSION_SECRET is needed — auth is bypassed via a no-op middleware.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type RequestHandler } from "express";
import { pool } from "@workspace/db";
import { createScannerRouter } from "../../routes/scanner.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** The single row id used by the production scanner (must match RESULT_ROW_ID). */
const RESULT_ROW_ID = 1;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCAN_TIME_A = "2026-08-01T10:00:00.000Z";
const DATA_AS_OF_A = "2026-08-01T10:01:00.000Z";
const STOCKS_A = [
  { symbol: "AAPL", qualified: true, qualifiedWithCaveats: false },
];
const FRESHNESS_A = { timestamp: SCAN_TIME_A, source: "live" as const };

const SCAN_TIME_B = "2026-08-01T12:00:00.000Z";
const DATA_AS_OF_B = "2026-08-01T12:01:00.000Z";
const STOCKS_B = [
  { symbol: "TSLA", qualified: false, qualifiedWithCaveats: true },
  { symbol: "NVDA", qualified: true, qualifiedWithCaveats: false },
];
const FRESHNESS_B = { timestamp: SCAN_TIME_B, source: "cache" as const };

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** Write a completed scan result directly to PostgreSQL (simulates a background worker). */
async function writeResult(opts: {
  stocks: unknown[];
  totalScanned: number;
  totalQualified: number;
  totalQualifiedWithCaveats: number;
  scanTime: string;
  dataAsOf: string;
  dataFreshness: unknown;
  status?: string;
}) {
  const runId = "test-run-" + Math.random().toString(36).slice(2);
  await pool.query(
    `
    INSERT INTO scanner_results (
      id, stocks, total_scanned, total_qualified,
      total_qualified_with_caveats, scan_time, data_as_of,
      data_freshness, status, run_id, updated_at
    ) VALUES (
      $1, $2::jsonb, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, now()
    )
    ON CONFLICT (id) DO UPDATE
      SET stocks                      = EXCLUDED.stocks,
          total_scanned               = EXCLUDED.total_scanned,
          total_qualified             = EXCLUDED.total_qualified,
          total_qualified_with_caveats = EXCLUDED.total_qualified_with_caveats,
          scan_time                   = EXCLUDED.scan_time,
          data_as_of                  = EXCLUDED.data_as_of,
          data_freshness              = EXCLUDED.data_freshness,
          status                      = EXCLUDED.status,
          run_id                      = EXCLUDED.run_id,
          updated_at                  = now()
    `,
    [
      RESULT_ROW_ID,
      JSON.stringify(opts.stocks),
      opts.totalScanned,
      opts.totalQualified,
      opts.totalQualifiedWithCaveats,
      opts.scanTime,
      opts.dataAsOf,
      JSON.stringify(opts.dataFreshness),
      opts.status ?? "complete",
      runId,
    ],
  );
}

/** Remove the scanner_results row so each test starts from a blank slate. */
async function clearResults() {
  await pool.query(
    `DELETE FROM scanner_results WHERE id = $1`,
    [RESULT_ROW_ID],
  );
}

// ─── Test Express app factory ─────────────────────────────────────────────────
//
// Each call returns an entirely new Express app with no shared in-memory state.
// The no-op auth middleware lets tests call the route without a real session.

const noOpAuth: RequestHandler = (_req, _res, next) => next();

function buildFreshApp(): express.Express {
  const app = express();
  app.use(express.json());
  // createScannerRouter with no-op auth — zero in-memory scan state.
  app.use("/api", createScannerRouter(noOpAuth));
  return app;
}

// ─── Server lifecycle helpers ─────────────────────────────────────────────────

interface TestServer {
  url: string;
  server: Server;
}

function startServer(): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(buildFreshApp());
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

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("Scanner result persistence across fresh router instances", () => {
  // Ensure the scanner_results table exists before running any tests.
  before(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scanner_results (
        id                           integer PRIMARY KEY DEFAULT 1,
        stocks                       jsonb   NOT NULL,
        total_scanned                integer NOT NULL,
        total_qualified              integer NOT NULL,
        total_qualified_with_caveats integer NOT NULL,
        scan_time                    text    NOT NULL,
        data_as_of                   text    NOT NULL,
        data_freshness               jsonb   NOT NULL,
        status                       text    NOT NULL DEFAULT 'idle',
        run_id                       text,
        updated_at                   timestamp DEFAULT now()
      )
    `);
  });

  // Remove the scanner row after each test so they are independent.
  afterEach(clearResults);

  // ── Core scenario ──────────────────────────────────────────────────────────

  it("GET /scanner/results on a fresh router returns results written by a previous instance", async () => {
    // Step 1 — "Instance A" writes a completed scan result to PostgreSQL.
    await writeResult({
      stocks: STOCKS_A,
      totalScanned: 1,
      totalQualified: 1,
      totalQualifiedWithCaveats: 0,
      scanTime: SCAN_TIME_A,
      dataAsOf: DATA_AS_OF_A,
      dataFreshness: FRESHNESS_A,
      status: "complete",
    });

    // Step 2 — Start "Instance B": a brand-new Express app with no in-memory
    // scan results whatsoever.
    const instanceB = await startServer();

    try {
      const res = await fetch(`${instanceB.url}/api/scanner/results`);

      assert.equal(
        res.status,
        200,
        `Expected 200 from Instance B, got ${res.status}`,
      );

      const body = (await res.json()) as Record<string, unknown>;

      // Must report that results are available.
      assert.equal(
        body["hasResults"],
        true,
        "Instance B must report hasResults=true after Instance A wrote to DB",
      );

      assert.equal(
        body["status"],
        "complete",
        `Expected status="complete", got ${JSON.stringify(body["status"])}`,
      );

      // lastScan must carry the data written by Instance A.
      const lastScan = body["lastScan"] as Record<string, unknown>;
      assert.ok(lastScan, "lastScan must be present");

      assert.equal(
        lastScan["scanTime"],
        SCAN_TIME_A,
        `scanTime mismatch: expected ${SCAN_TIME_A}, got ${lastScan["scanTime"]}`,
      );

      assert.equal(
        lastScan["totalScanned"],
        1,
        `totalScanned must be 1 (got ${lastScan["totalScanned"]})`,
      );

      assert.equal(
        lastScan["totalQualified"],
        1,
        `totalQualified must be 1 (got ${lastScan["totalQualified"]})`,
      );

      // Stocks array must contain the exact entry written by Instance A.
      const stocks = lastScan["stocks"] as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(stocks), "lastScan.stocks must be an array");
      assert.equal(stocks.length, 1, "stocks array must have 1 entry");
      assert.equal(
        stocks[0]?.["symbol"],
        "AAPL",
        `stocks[0].symbol must be "AAPL" (got ${stocks[0]?.["symbol"]})`,
      );

      assert.equal(
        body["lastScanTime"],
        SCAN_TIME_A,
        `lastScanTime must match scanTime (got ${body["lastScanTime"]})`,
      );
    } finally {
      await stopServer(instanceB.server);
    }
  });

  // ── Upsert (second scan overwrites first) ──────────────────────────────────

  it("a second scan upsert overwrites the first — fresh router reads the latest write", async () => {
    // Write scan A first.
    await writeResult({
      stocks: STOCKS_A,
      totalScanned: 1,
      totalQualified: 1,
      totalQualifiedWithCaveats: 0,
      scanTime: SCAN_TIME_A,
      dataAsOf: DATA_AS_OF_A,
      dataFreshness: FRESHNESS_A,
    });

    // Write scan B second — this should upsert over scan A.
    await writeResult({
      stocks: STOCKS_B,
      totalScanned: 2,
      totalQualified: 1,
      totalQualifiedWithCaveats: 1,
      scanTime: SCAN_TIME_B,
      dataAsOf: DATA_AS_OF_B,
      dataFreshness: FRESHNESS_B,
    });

    // Start a completely fresh router instance.
    const instanceC = await startServer();

    try {
      const res = await fetch(`${instanceC.url}/api/scanner/results`);
      assert.equal(res.status, 200);

      const body = (await res.json()) as Record<string, unknown>;
      const lastScan = body["lastScan"] as Record<string, unknown>;
      assert.ok(lastScan, "lastScan must be present after upsert");

      // Must reflect scan B, not scan A.
      assert.equal(
        lastScan["scanTime"],
        SCAN_TIME_B,
        `scanTime must reflect the second (upserted) scan: expected ${SCAN_TIME_B}, got ${lastScan["scanTime"]}`,
      );

      assert.equal(
        lastScan["totalScanned"],
        2,
        `totalScanned must be 2 after upsert (got ${lastScan["totalScanned"]})`,
      );

      assert.equal(
        lastScan["totalQualified"],
        1,
        `totalQualified must be 1 after upsert (got ${lastScan["totalQualified"]})`,
      );

      assert.equal(
        lastScan["totalQualifiedWithCaveats"],
        1,
        `totalQualifiedWithCaveats must be 1 after upsert (got ${lastScan["totalQualifiedWithCaveats"]})`,
      );

      const stocks = lastScan["stocks"] as Array<Record<string, unknown>>;
      assert.equal(
        stocks.length,
        2,
        "stocks array must have 2 entries after upsert (scan B had 2 stocks)",
      );

      const symbols = stocks.map((s) => s["symbol"]);
      assert.ok(
        symbols.includes("TSLA"),
        `stocks must include TSLA after upsert (got ${JSON.stringify(symbols)})`,
      );
      assert.ok(
        symbols.includes("NVDA"),
        `stocks must include NVDA after upsert (got ${JSON.stringify(symbols)})`,
      );
    } finally {
      await stopServer(instanceC.server);
    }
  });

  // ── No results yet ─────────────────────────────────────────────────────────

  it("GET /scanner/results on a fresh router returns hasResults=false when no scan has run", async () => {
    // No write — table is empty after afterEach cleared it.
    const instance = await startServer();

    try {
      const res = await fetch(`${instance.url}/api/scanner/results`);
      assert.equal(res.status, 200);

      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(
        body["hasResults"],
        false,
        `hasResults must be false when no scan has run (got ${body["hasResults"]})`,
      );
      assert.equal(
        body["lastScan"],
        null,
        `lastScan must be null when no scan has run (got ${JSON.stringify(body["lastScan"])})`,
      );
    } finally {
      await stopServer(instance.server);
    }
  });
});
