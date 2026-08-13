/**
 * Application-level singletons
 *
 * Initialize once at startup and share across route handlers.
 * Authentication is now handled by Clerk + Circle membership checks
 * (see lib/circle-membership.ts and middlewares/require-auth.ts).
 */

import { createMarketDataProvider } from "./lib/market-data.js";
import { screeningEngine } from "./lib/screening-engine.js";
import { logger } from "./lib/logger.js";

export const marketDataProvider = createMarketDataProvider();
export { screeningEngine };

logger.info(
  { dataProvider: marketDataProvider.providerName },
  "Services initialized"
);
