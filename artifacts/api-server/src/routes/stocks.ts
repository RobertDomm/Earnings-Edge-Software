/**
 * Stock detail route
 *
 * GET /api/stocks/:symbol — returns full stock detail, options chain, filter breakdown
 */

import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/require-auth.js";
import { marketDataProvider, screeningEngine } from "../services.js";

const router: IRouter = Router();

router.get("/stocks/:symbol", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.symbol)
    ? req.params.symbol[0]
    : req.params.symbol;
  const symbol = raw?.toUpperCase();

  if (!symbol || !/^[A-Z]{1,10}$/.test(symbol)) {
    res.status(400).json({ error: "Invalid symbol" });
    return;
  }

  const [quote, optionsChain] = await Promise.all([
    marketDataProvider.getStockQuote(symbol),
    marketDataProvider.getOptionsChain(symbol),
  ]);

  if (!quote) {
    res.status(404).json({ error: `Symbol ${symbol} not found` });
    return;
  }

  const screeningResult = screeningEngine.evaluateStock(quote);

  res.json({
    stock: screeningResult,
    optionsChain: optionsChain ?? {
      symbol,
      expirations: [],
      contracts: [],
    },
  });
});

export default router;
