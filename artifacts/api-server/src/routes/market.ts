/**
 * Market status route
 *
 * GET /api/market/status — returns current market hours state (requires auth)
 */

import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/require-auth.js";
import { marketDataProvider } from "../services.js";

const router: IRouter = Router();

router.get("/market/status", requireAuth, async (req, res): Promise<void> => {
  const status = await marketDataProvider.getMarketStatus();

  res.json({
    state: status.state,
    label: status.label,
    description: status.description,
    timestamp: status.timestamp.toISOString(),
    nextOpen: status.nextOpen ? status.nextOpen.toISOString() : null,
    nextClose: status.nextClose ? status.nextClose.toISOString() : null,
  });
});

export default router;
