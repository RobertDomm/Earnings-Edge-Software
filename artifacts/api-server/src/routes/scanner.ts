/**
 * Scanner routes
 *
 * POST /api/scanner/run      — run the screening engine (requires auth)
 * GET  /api/scanner/results  — get last scan results + status (requires auth)
 */

import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/require-auth.js";
import { marketDataProvider, screeningEngine } from "../services.js";

const router: IRouter = Router();

// In-memory scan state — shared across all requests
// In a multi-instance deployment, this would move to a database/cache layer
let lastScanResult: {
  stocks: ReturnType<typeof screeningEngine.runScreening>;
  totalScanned: number;
  totalQualified: number;
  scanTime: string;
  dataAsOf: string;
} | null = null;

let scannerStatus: "idle" | "running" | "complete" | "error" = "idle";

// POST /scanner/run — run the scanner
router.post("/scanner/run", requireAuth, async (req, res): Promise<void> => {
  if (scannerStatus === "running") {
    res.status(409).json({ error: "Scanner is already running" });
    return;
  }

  scannerStatus = "running";
  const scanTime = new Date();

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

    req.log.info(
      {
        totalScanned: lastScanResult.totalScanned,
        totalQualified: lastScanResult.totalQualified,
      },
      "Scanner run complete"
    );

    res.json(lastScanResult);
  } catch (err) {
    scannerStatus = "error";
    req.log.error({ err }, "Scanner run failed");
    res.status(500).json({ error: "Scanner encountered an error" });
  }
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
