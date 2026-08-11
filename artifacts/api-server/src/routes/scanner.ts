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
 */

import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/require-auth.js";
import { marketDataProvider, screeningEngine } from "../services.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// In-memory scan state — shared across all requests for this process.
// In a multi-instance deployment this would live in a shared cache/database.
let lastScanResult: {
  stocks: ReturnType<typeof screeningEngine.runScreening>;
  totalScanned: number;
  totalQualified: number;
  scanTime: string;
  dataAsOf: string;
} | null = null;

let scannerStatus: "idle" | "running" | "complete" | "error" = "idle";

// POST /scanner/run — start a scan
router.post("/scanner/run", requireAuth, async (_req, res): Promise<void> => {
  if (scannerStatus === "running") {
    res.status(409).json({ error: "Scanner is already running" });
    return;
  }

  scannerStatus = "running";

  // Respond immediately with the most recent scan result (may be from a
  // previous run).  The client polls GET /scanner/results for completion.
  res.json(
    lastScanResult ?? {
      stocks: [],
      totalScanned: 0,
      totalQualified: 0,
      scanTime: new Date().toISOString(),
      dataAsOf: new Date().toISOString(),
    }
  );

  // Run the actual scan as a background task after the HTTP response is sent.
  const scanTime = new Date();
  void (async () => {
    try {
      const stocks = await marketDataProvider.getStockUniverse();
      const results = screeningEngine.runScreening(stocks);

      lastScanResult = {
        stocks: results,
        totalScanned: results.length,
        totalQualified: results.filter((r) => r.qualified).length,
        scanTime: scanTime.toISOString(),
        dataAsOf: new Date().toISOString(),
      };
      scannerStatus = "complete";

      logger.info(
        {
          totalScanned: lastScanResult.totalScanned,
          totalQualified: lastScanResult.totalQualified,
        },
        "Scanner run complete"
      );
    } catch (err) {
      scannerStatus = "error";
      logger.error({ err }, "Scanner run failed");
    }
  })();
});

// GET /scanner/results — get last scan results and status
router.get("/scanner/results", requireAuth, async (_req, res): Promise<void> => {
  if (!lastScanResult) {
    res.json({
      hasResults: false,
      status: scannerStatus,
      lastScan: null,
      lastScanTime: null,
    });
    return;
  }

  res.json({
    hasResults: true,
    status: scannerStatus,
    lastScan: lastScanResult,
    lastScanTime: lastScanResult.scanTime,
  });
});

export default router;
