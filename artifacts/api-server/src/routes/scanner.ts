/**
 * Scanner routes
 *
 * POST /api/scanner/run      — start a scan (requires auth)
 * GET  /api/scanner/results  — get scan status + last results (requires auth)
 *
 * The POST endpoint responds immediately (HTTP 200) with the most recent
 * scan data (or an empty placeholder if no scan has run yet) and kicks off
 * the actual enrichment + screening as a fire-and-forget background task.
 * This ensures the HTTP response always completes well within server timeout
 * budgets, regardless of how long the underlying market-data API calls take.
 *
 * Clients should poll GET /api/scanner/results (or watch the status field)
 * to detect when a scan transitions from "running" → "complete" | "error".
 *
 * Scan results AND scan status are persisted in PostgreSQL so all autoscale
 * instances share a consistent view — no in-memory state is used for either.
 *
 * ## Ownership / lease safety
 *
 * The scan "claim" uses an atomic conditional SQL upsert that also writes a
 * unique run_id. Completion and error writes are conditioned on the run_id
 * matching, so if a stale lock is reclaimed by a new instance, the original
 * worker's writes are no-ops and cannot overwrite the new worker's state.
 *
 * A 10-minute lease (tracked via updated_at) ensures a dead/restarted
 * instance cannot block scans indefinitely — stale locks are reclaimed after
 * the lease window passes.
 */

import { randomUUID } from "node:crypto";
import { Router, type IRouter, type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/require-auth.js";
import { marketDataProvider as defaultMarketDataProvider, screeningEngine as defaultScreeningEngine } from "../services.js";
import type { IMarketDataProvider } from "../lib/market-data.js";
import type { ScreeningEngine } from "../lib/screening-engine.js";
import { getFilterDefinitions } from "../lib/screening-engine.js";
import { logger } from "../lib/logger.js";
import { db, pool, scannerResultsTable } from "@workspace/db";

// The single row that holds the latest scan result uses id=1.
const RESULT_ROW_ID = 1;

// Scans should complete in seconds. 10 minutes is a generous upper bound;
// any "running" row older than this is treated as an abandoned lease.
const LEASE_WINDOW_MINUTES = 10;

type ScanStatus = "idle" | "running" | "complete" | "error";

async function loadRow() {
  const rows = await db
    .select()
    .from(scannerResultsTable)
    .where(eq(scannerResultsTable.id, RESULT_ROW_ID))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Atomically claim the scanner slot by setting status = 'running' and
 * writing a fresh run_id as the ownership token.
 *
 * The WHERE clause on the DO UPDATE path allows two cases to win the claim:
 *   1. status is not 'running' — normal, uncontested claim
 *   2. status is 'running' but the lock is >LEASE_WINDOW_MINUTES old —
 *      the original holder died; the new instance reclaims the slot
 *
 * Returns the run_id string when the caller won the claim, or `null` when
 * another instance holds an active (non-expired) lock.
 */
async function claimScannerSlot(): Promise<string | null> {
  const runId = randomUUID();
  const result = await pool.query<{ id: number }>(`
    INSERT INTO scanner_results (
      id, stocks, total_scanned, total_qualified,
      total_qualified_with_caveats, scan_time, data_as_of,
      data_freshness, status, run_id, updated_at
    ) VALUES (
      $1, '[]'::jsonb, 0, 0, 0, '', '', '{}'::jsonb, 'running', $2, now()
    )
    ON CONFLICT (id) DO UPDATE
      SET status = 'running', run_id = $2, updated_at = now()
      WHERE scanner_results.status <> 'running'
         OR scanner_results.updated_at < now() - ($3 || ' minutes')::interval
    RETURNING id
  `, [RESULT_ROW_ID, runId, LEASE_WINDOW_MINUTES]);

  if (result.rowCount != null && result.rowCount > 0) {
    return runId;
  }
  return null;
}

/**
 * Write the final scan outcome back to the DB, but ONLY if this worker still
 * owns the slot (run_id matches). If the lease was reclaimed by another
 * instance, this is intentionally a no-op.
 */
async function finalizeScan(
  runId: string,
  status: "complete" | "error",
  data?: {
    stocks: unknown[];
    totalScanned: number;
    totalQualified: number;
    totalQualifiedWithCaveats: number;
    scanTime: string;
    dataAsOf: string;
    dataFreshness: unknown;
  },
) {
  if (data) {
    await pool.query(`
      UPDATE scanner_results
      SET status            = $2,
          stocks            = $3::jsonb,
          total_scanned     = $4,
          total_qualified   = $5,
          total_qualified_with_caveats = $6,
          scan_time         = $7,
          data_as_of        = $8,
          data_freshness    = $9::jsonb,
          updated_at        = now()
      WHERE id = $1 AND run_id = $10
    `, [
      RESULT_ROW_ID, status,
      JSON.stringify(data.stocks),
      data.totalScanned,
      data.totalQualified,
      data.totalQualifiedWithCaveats,
      data.scanTime,
      data.dataAsOf,
      JSON.stringify(data.dataFreshness),
      runId,
    ]);
  } else {
    await pool.query(`
      UPDATE scanner_results
      SET status = $2, updated_at = now()
      WHERE id = $1 AND run_id = $3
    `, [RESULT_ROW_ID, status, runId]);
  }
}

/**
 * Factory — returns a fully configured scanner router.
 *
 * All three parameters are optional so that tests can inject stubs:
 *   - `authMiddleware`   — pass a no-op in tests to skip session checks
 *   - `marketProvider`  — pass a stub to avoid real network calls
 *   - `engine`          — pass a stub when only exercising DB / route logic
 *
 * The production default export calls this with the real singletons.
 */
export function createScannerRouter(
  authMiddleware: RequestHandler = requireAuth,
  marketProvider: IMarketDataProvider = defaultMarketDataProvider,
  engine: ScreeningEngine = defaultScreeningEngine,
): IRouter {
  const router: IRouter = Router();

  // GET /scanner/filters — return static filter definitions
  router.get("/scanner/filters", authMiddleware, (_req, res): void => {
    res.json({ filters: getFilterDefinitions() });
  });

  // POST /scanner/run — start a scan
  router.post("/scanner/run", authMiddleware, async (_req, res): Promise<void> => {
    // Atomically claim the scanner slot. Returns null when another instance
    // holds an active (non-expired) lock.
    const runId = await claimScannerSlot();
    if (!runId) {
      res.status(409).json({ error: "Scanner is already running" });
      return;
    }

    // Respond immediately with the most recent result payload (may be from a
    // previous run on any instance). The client polls GET /scanner/results.
    const existing = await loadRow();
    const now = new Date().toISOString();
    res.json(
      existing && existing.scanTime
        ? {
            stocks: existing.stocks,
            totalScanned: existing.totalScanned,
            totalQualified: existing.totalQualified,
            totalQualifiedWithCaveats: existing.totalQualifiedWithCaveats,
            scanTime: existing.scanTime,
            dataAsOf: existing.dataAsOf,
            dataFreshness: existing.dataFreshness,
            status: "running",
          }
        : {
            stocks: [],
            totalScanned: 0,
            totalQualified: 0,
            totalQualifiedWithCaveats: 0,
            scanTime: now,
            dataAsOf: now,
            dataFreshness: { timestamp: now, source: "live" },
            status: "running",
          }
    );

    // Run the actual scan as a background task after the HTTP response is sent.
    const scanTime = new Date();
    void (async () => {
      try {
        const { stocks, dataFreshness } = await marketProvider.getStockUniverse();
        const results = engine.runScreening(stocks);

        await finalizeScan(runId, "complete", {
          stocks: results,
          totalScanned: results.length,
          totalQualified: results.filter((r) => r.qualified).length,
          totalQualifiedWithCaveats: results.filter((r) => r.qualifiedWithCaveats).length,
          scanTime: scanTime.toISOString(),
          dataAsOf: new Date().toISOString(),
          dataFreshness,
        });

        logger.info(
          {
            totalScanned: results.length,
            totalQualified: results.filter((r) => r.qualified).length,
            totalQualifiedWithCaveats: results.filter((r) => r.qualifiedWithCaveats).length,
            runId,
          },
          "Scanner run complete"
        );
      } catch (err) {
        // Error write is also run_id-gated; if another instance reclaimed the
        // slot, we log but do not overwrite its state.
        await finalizeScan(runId, "error");
        logger.error({ err, runId }, "Scanner run failed");
      }
    })();
  });

  // GET /scanner/results — get last scan results and status
  router.get("/scanner/results", authMiddleware, async (_req, res): Promise<void> => {
    const row = await loadRow();

    if (!row || !row.scanTime) {
      res.json({
        hasResults: false,
        status: (row?.status ?? "idle") as ScanStatus,
        lastScan: null,
        lastScanTime: null,
      });
      return;
    }

    res.json({
      hasResults: true,
      status: row.status as ScanStatus,
      lastScan: {
        stocks: row.stocks,
        totalScanned: row.totalScanned,
        totalQualified: row.totalQualified,
        totalQualifiedWithCaveats: row.totalQualifiedWithCaveats,
        scanTime: row.scanTime,
        dataAsOf: row.dataAsOf,
        dataFreshness: row.dataFreshness,
      },
      lastScanTime: row.scanTime,
    });
  });

  return router;
}

/** Production default: real auth, real market provider, real screening engine. */
export default createScannerRouter();
