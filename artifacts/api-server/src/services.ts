/**
 * Application-level singletons
 *
 * Initialize once at startup and share across route handlers.
 */

import { createCircleAuthService } from "./lib/mock-circle-auth.js";
import { createMarketDataProvider } from "./lib/market-data.js";
import { screeningEngine } from "./lib/screening-engine.js";
import { logger } from "./lib/logger.js";

export const circleAuthService = createCircleAuthService();
export const marketDataProvider = createMarketDataProvider();
export { screeningEngine };

logger.info(
  {
    authMode: circleAuthService.mode,
    dataProvider: marketDataProvider.providerName,
  },
  "Services initialized"
);
