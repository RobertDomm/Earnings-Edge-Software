/**
 * Screener route
 *
 * GET /api/screener — synchronous scan of the stock universe
 *
 * Unlike POST /scanner/run (fire-and-forget), this endpoint awaits the market
 * data provider synchronously so that errors propagate directly to the caller
 * as machine-readable HTTP status codes.
 *
 * Response codes:
 *   200  — scan completed (results array may be empty when nothing qualifies
 *           OR when the provider returns an empty universe)
 *   503  — market data provider threw or was completely unavailable
 *
 * The route is exposed as a factory so the provider (and optionally the auth
 * middleware) can be injected in tests.
 */

import { Router, type IRouter, type RequestHandler } from "express";
import type { IMarketDataProvider } from "../lib/market-data.js";
import { screeningEngine } from "../lib/screening-engine.js";
import { requireAuth } from "../middlewares/require-auth.js";
import { logger } from "../lib/logger.js";

export function createScreenerRouter(
  provider: IMarketDataProvider,
  /** Optional override for the auth middleware — pass a no-op in tests. */
  authMiddleware: RequestHandler = requireAuth,
): IRouter {
  const router: IRouter = Router();

  router.get(
    "/screener",
    authMiddleware,
    async (_req, res): Promise<void> => {
      let universeResult;

      try {
        universeResult = await provider.getStockUniverse();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown market data error";
        logger.error({ err }, "Screener: market data provider threw");

        res.status(503).json({
          error: "Market data unavailable",
          detail: message,
          results: null,
        });
        return;
      }

      const { stocks, dataFreshness } = universeResult;

      if (stocks.length === 0) {
        res.json({
          message:
            "Market data provider returned an empty universe — no stocks to screen",
          results: [],
          totalScanned: 0,
          totalQualified: 0,
          dataFreshness,
        });
        return;
      }

      const results = screeningEngine.runScreening(stocks);

      res.json({
        results,
        totalScanned: stocks.length,
        totalQualified: results.filter((r) => r.qualified).length,
        dataFreshness,
      });
    },
  );

  return router;
}
