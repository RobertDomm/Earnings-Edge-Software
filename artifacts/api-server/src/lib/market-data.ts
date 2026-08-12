/**
 * Market Data Provider
 *
 * Defines the IMarketDataProvider interface, MockMarketDataProvider (dev/test),
 * and LiveMarketDataProvider (production, Polygon.io).
 *
 * To switch to live data:
 *  1. Set MARKET_DATA_PROVIDER=live in environment
 *  2. Set MARKET_DATA_API_KEY=<your Polygon.io key> in Replit Secrets
 *  3. (Optional) Set POLYGON_REQUESTS_PER_MINUTE to match your Polygon plan
 *     (default: 5 for free tier; paid Starter plan supports ~100+;
 *      set to 0 to disable rate limiting entirely — only for testing)
 *  4. (Optional) Set UNIVERSE_CACHE_TTL_SECONDS (default: 300 = 5 minutes)
 *  5. Restart the API server
 *
 * The live provider maintains an in-memory universe cache with
 * stale-while-revalidate semantics.  Background enrichment (options stats +
 * 30-day avg volume) starts immediately on server startup so that the first
 * scan can serve data from cache rather than blocking an HTTP request.
 */

export interface StockQuote {
  symbol: string;
  company: string;
  price: number;
  dailyChangePercent: number;
  volume: number;
  avgVolume: number;
  marketCap: number;
  impliedVolatility: number;
  optionsVolume: number;
  openInterest: number;
  /**
   * Broad sector classification used by Filter 1.
   * Values: "tech" | "finance" | "consumer" | "automotive" | "oil" |
   *         "healthcare" | "biotech" | "defense" | "etf" | "other"
   */
  sector: string;
  /**
   * Estimated next earnings announcement date (YYYY-MM-DD), or null if unknown.
   * Used by Filter 2. Live provider derives this from the most recent SEC filing
   * date + 91 days; mock provider uses hardcoded realistic dates.
   */
  nextEarningsDate: string | null;
  /**
   * Options liquidity metrics computed from the ~11 DTE chain.
   * Used by Filter 3. Null when no options data is available.
   */
  liquidityMetrics: OptionsLiquidityMetrics | null;
  /**
   * Realized-vol history around each of the last 4 earnings cycles.
   * Used by Filter 4. Null when fewer than 4 cycles of data exist.
   */
  earningsIvHistory: EarningsIvRecord[] | null;
}

export interface OptionsContract {
  strike: number;
  expiration: string; // YYYY-MM-DD
  callBid: number;
  callAsk: number;
  callVolume: number;
  callOI: number;
  callIV: number;
  callDelta: number;
  callGamma: number;
  callTheta: number;
  callVega: number;
  putBid: number;
  putAsk: number;
  putVolume: number;
  putOI: number;
  putIV: number;
  putDelta: number;
  putGamma: number;
  putTheta: number;
  putVega: number;
}

export interface OptionsChain {
  symbol: string;
  expirations: string[];
  contracts: OptionsContract[];
}

export interface MarketStatusData {
  state: "open" | "closed" | "pre_market" | "after_hours";
  label: string;
  description: string;
  timestamp: Date;
  nextOpen: Date | null;
  nextClose: Date | null;
}

export interface DataFreshness {
  /** ISO timestamp of when the data was fetched from the upstream source */
  timestamp: string;
  /** "live" = just fetched; "cached" = returned from stale cache because the upstream was unreachable */
  source: "live" | "cached";
}

/**
 * Historical IV behaviour around one past earnings announcement.
 * The live provider approximates IV using annualized close-to-close
 * realized volatility (the only historical vol metric available via
 * Polygon's standard aggregates endpoint).
 */
export interface EarningsIvRecord {
  /** The earnings announcement date (YYYY-MM-DD, approximated by SEC filing date). */
  earningsDate: string;
  /** Annualized realized vol in the ~5 trading days immediately before earnings. */
  ivBeforeEarnings: number;
  /** Annualized realized vol in the baseline window ~30–15 days before earnings. */
  ivBaseline: number;
  /** True when ivBeforeEarnings > ivBaseline (IV expanded into earnings). */
  ivRose: boolean;
}

/**
 * Options liquidity metrics computed from the ~11 DTE option chain.
 * Used by Filter 3. All four sub-rules must pass for a stock to qualify.
 */
export interface OptionsLiquidityMetrics {
  /** True if any expiration falls on a non-3rd-Friday date (weekly options exist). */
  hasWeeklyOptions: boolean;
  /** True if any bid/ask in the $0.20–$0.70 range uses sub-5-cent increments. */
  hasPennyIncrements: boolean;
  /** Average bid/ask spread of $0.20–$0.70 options near 11 DTE; null if no data. */
  nearTermSpread: number | null;
  /** Actual DTE of the near-term chain that was examined; null if no data. */
  nearTermDte: number | null;
  /**
   * Median implied volatility of the near-term chain (~11 DTE); null if no data.
   * Used by Filter 5: elevated near-term IV vs. the stock's aggregate IV confirms
   * the options market is pricing in an upcoming earnings event.
   */
  nearTermIv: number | null;
}

export interface StockUniverseResult {
  stocks: StockQuote[];
  dataFreshness: DataFreshness;
}

export interface IMarketDataProvider {
  /** Returns all stocks available for screening, plus data-freshness metadata */
  getStockUniverse(): Promise<StockUniverseResult>;
  /** Returns quote for a single symbol, or null if not found */
  getStockQuote(symbol: string): Promise<StockQuote | null>;
  /** Returns the options chain for a symbol */
  getOptionsChain(symbol: string): Promise<OptionsChain | null>;
  /** Returns current market hours status */
  getMarketStatus(): Promise<MarketStatusData>;
  readonly providerName: string;
}

// ---------------------------------------------------------------------------
// MOCK MARKET DATA — clearly labeled as development/test data
// ---------------------------------------------------------------------------

const MOCK_STOCKS: StockQuote[] = [
  {
    symbol: "AAPL",
    company: "Apple Inc.",
    price: 189.84,
    dailyChangePercent: 1.23,
    volume: 58_420_100,
    avgVolume: 54_312_000,
    marketCap: 2_940_000_000_000,
    impliedVolatility: 0.248,
    optionsVolume: 482_300,
    openInterest: 1_240_500,
    sector: "tech",
    nextEarningsDate: "2026-08-26", // 14 days → PASS F2 (window: 14–18d)
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.17, nearTermDte: 11, nearTermIv: 0.451 },
    earningsIvHistory: [ // 4/4 rise → PASS F4
      { earningsDate: "2025-08-09", ivBaseline: 0.276, ivBeforeEarnings: 0.418, ivRose: true },
      { earningsDate: "2025-11-07", ivBaseline: 0.312, ivBeforeEarnings: 0.467, ivRose: true },
      { earningsDate: "2026-02-06", ivBaseline: 0.258, ivBeforeEarnings: 0.391, ivRose: true },
      { earningsDate: "2026-05-08", ivBaseline: 0.294, ivBeforeEarnings: 0.443, ivRose: true },
    ],
  },
  {
    symbol: "NVDA",
    company: "NVIDIA Corporation",
    price: 875.39,
    dailyChangePercent: 3.42,
    volume: 41_200_300,
    avgVolume: 38_700_000,
    marketCap: 2_160_000_000_000,
    impliedVolatility: 0.512,
    optionsVolume: 1_823_400,
    openInterest: 3_482_100,
    sector: "tech",
    nextEarningsDate: "2026-09-05", // 24 days → FAIL F2
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.62, nearTermDte: 9, nearTermIv: 0.548 }, // FAIL F3 (spread); F5: 0.548/0.512=1.07 — no elevation (earnings 24d away)
    earningsIvHistory: [ // 4/4 rise (solid pattern but fails F2+F3)
      { earningsDate: "2025-08-09", ivBaseline: 0.512, ivBeforeEarnings: 0.781, ivRose: true },
      { earningsDate: "2025-11-07", ivBaseline: 0.548, ivBeforeEarnings: 0.824, ivRose: true },
      { earningsDate: "2026-02-06", ivBaseline: 0.487, ivBeforeEarnings: 0.723, ivRose: true },
      { earningsDate: "2026-05-08", ivBaseline: 0.524, ivBeforeEarnings: 0.798, ivRose: true },
    ],
  },
  {
    symbol: "MSFT",
    company: "Microsoft Corporation",
    price: 415.26,
    dailyChangePercent: 0.87,
    volume: 22_100_500,
    avgVolume: 20_450_000,
    marketCap: 3_090_000_000_000,
    impliedVolatility: 0.198,
    optionsVolume: 238_700,
    openInterest: 892_300,
    sector: "tech",
    nextEarningsDate: "2026-09-10", // 29 days → FAIL F2
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.22, nearTermDte: 11, nearTermIv: 0.214 }, // F5: 0.214/0.198=1.08 — flat (earnings 29d away)
    earningsIvHistory: [ // 4/4 rise (would qualify if earnings were in window)
      { earningsDate: "2025-08-09", ivBaseline: 0.198, ivBeforeEarnings: 0.281, ivRose: true },
      { earningsDate: "2025-11-07", ivBaseline: 0.214, ivBeforeEarnings: 0.306, ivRose: true },
      { earningsDate: "2026-02-06", ivBaseline: 0.189, ivBeforeEarnings: 0.271, ivRose: true },
      { earningsDate: "2026-05-08", ivBaseline: 0.203, ivBeforeEarnings: 0.289, ivRose: true },
    ],
  },
  {
    symbol: "TSLA",
    company: "Tesla, Inc.",
    price: 248.42,
    dailyChangePercent: -2.14,
    volume: 118_430_000,
    avgVolume: 98_250_000,
    marketCap: 792_000_000_000,
    impliedVolatility: 0.672,
    optionsVolume: 2_341_800,
    openInterest: 4_821_600,
    sector: "automotive",
    nextEarningsDate: "2026-08-27", // 15 days → PASS F2 (but fails F4)
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.27, nearTermDte: 12, nearTermIv: 0.948 }, // F5: 0.948/0.672=1.41 ✓ (but fails F4)
    earningsIvHistory: [ // 3/4 rise → FAIL F4 (IV dropped one cycle)
      { earningsDate: "2025-08-09", ivBaseline: 0.724, ivBeforeEarnings: 0.981, ivRose: true },
      { earningsDate: "2025-11-07", ivBaseline: 0.681, ivBeforeEarnings: 0.823, ivRose: true },
      { earningsDate: "2026-02-06", ivBaseline: 0.752, ivBeforeEarnings: 0.709, ivRose: false }, // IV dropped — unusual
      { earningsDate: "2026-05-08", ivBaseline: 0.698, ivBeforeEarnings: 0.887, ivRose: true },
    ],
  },
  {
    symbol: "META",
    company: "Meta Platforms, Inc.",
    price: 512.77,
    dailyChangePercent: 1.98,
    volume: 18_920_400,
    avgVolume: 16_830_000,
    marketCap: 1_310_000_000_000,
    impliedVolatility: 0.341,
    optionsVolume: 412_900,
    openInterest: 1_102_400,
    sector: "tech",
    nextEarningsDate: "2026-08-29", // 17 days → PASS F2
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.31, nearTermDte: 10, nearTermIv: 0.521 }, // F5: 0.521/0.341=1.53 ✓
    earningsIvHistory: [ // 4/4 rise → PASS F4
      { earningsDate: "2025-08-09", ivBaseline: 0.342, ivBeforeEarnings: 0.524, ivRose: true },
      { earningsDate: "2025-11-07", ivBaseline: 0.378, ivBeforeEarnings: 0.563, ivRose: true },
      { earningsDate: "2026-02-06", ivBaseline: 0.321, ivBeforeEarnings: 0.487, ivRose: true },
      { earningsDate: "2026-05-08", ivBaseline: 0.356, ivBeforeEarnings: 0.542, ivRose: true },
    ],
  },
  {
    symbol: "AMZN",
    company: "Amazon.com, Inc.",
    price: 192.83,
    dailyChangePercent: 0.54,
    volume: 34_120_700,
    avgVolume: 31_450_000,
    marketCap: 2_020_000_000_000,
    impliedVolatility: 0.274,
    optionsVolume: 387_200,
    openInterest: 1_048_300,
    sector: "tech",
    nextEarningsDate: "2026-08-14", // 2 days → FAIL F2 (too close — window opens at 14d)
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.24, nearTermDte: 9, nearTermIv: 0.281 }, // F5: 0.281/0.274=1.03 — flat (earnings 18d away)
    earningsIvHistory: null, // earnings outside window; skip for mock clarity
  },
  {
    symbol: "AMD",
    company: "Advanced Micro Devices",
    price: 168.24,
    dailyChangePercent: 4.12,
    volume: 67_840_200,
    avgVolume: 58_920_000,
    marketCap: 272_000_000_000,
    impliedVolatility: 0.594,
    optionsVolume: 1_284_700,
    openInterest: 2_937_100,
    sector: "tech",
    nextEarningsDate: "2026-08-28", // 16 days → PASS F2
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.22, nearTermDte: 12, nearTermIv: 0.847 }, // F5: 0.847/0.594=1.43 ✓
    earningsIvHistory: [ // 4/4 rise → PASS F4
      { earningsDate: "2025-08-09", ivBaseline: 0.581, ivBeforeEarnings: 0.842, ivRose: true },
      { earningsDate: "2025-11-07", ivBaseline: 0.623, ivBeforeEarnings: 0.908, ivRose: true },
      { earningsDate: "2026-02-06", ivBaseline: 0.547, ivBeforeEarnings: 0.781, ivRose: true },
      { earningsDate: "2026-05-08", ivBaseline: 0.601, ivBeforeEarnings: 0.872, ivRose: true },
    ],
  },
  {
    symbol: "SPY",
    company: "SPDR S&P 500 ETF Trust",
    price: 524.18,
    dailyChangePercent: 0.31,
    volume: 72_341_900,
    avgVolume: 68_120_000,
    marketCap: 0,
    impliedVolatility: 0.142,
    optionsVolume: 4_821_300,
    openInterest: 12_483_200,
    sector: "etf",
    nextEarningsDate: null, // ETF — no earnings → FAIL F2
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.05, nearTermDte: 7, nearTermIv: 0.145 }, // F5: 0.145/0.142=1.02 — flat (ETF, no earnings)
    earningsIvHistory: null, // ETF — no earnings cycle
  },
  {
    symbol: "GOOGL",
    company: "Alphabet Inc. Class A",
    price: 178.92,
    dailyChangePercent: -0.62,
    volume: 26_870_400,
    avgVolume: 24_210_000,
    marketCap: 2_190_000_000_000,
    impliedVolatility: 0.231,
    optionsVolume: 298_100,
    openInterest: 748_600,
    sector: "tech",
    nextEarningsDate: "2026-08-28", // 16 days → PASS F2
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.19, nearTermDte: 14, nearTermIv: 0.419 }, // F5: 0.419/0.231=1.81 ✓
    earningsIvHistory: [ // 4/4 rise → PASS F4
      { earningsDate: "2025-08-09", ivBaseline: 0.271, ivBeforeEarnings: 0.413, ivRose: true },
      { earningsDate: "2025-11-07", ivBaseline: 0.303, ivBeforeEarnings: 0.447, ivRose: true },
      { earningsDate: "2026-02-06", ivBaseline: 0.251, ivBeforeEarnings: 0.383, ivRose: true },
      { earningsDate: "2026-05-08", ivBaseline: 0.285, ivBeforeEarnings: 0.422, ivRose: true },
    ],
  },
  {
    symbol: "COIN",
    company: "Coinbase Global, Inc.",
    price: 224.67,
    dailyChangePercent: 6.83,
    volume: 19_420_100,
    avgVolume: 12_840_000,
    marketCap: 54_200_000_000,
    impliedVolatility: 0.891,
    optionsVolume: 892_400,
    openInterest: 1_823_700,
    sector: "tech",
    nextEarningsDate: "2026-09-01", // 20 days → FAIL F2
    liquidityMetrics: { hasWeeklyOptions: false, hasPennyIncrements: false, nearTermSpread: 0.45, nearTermDte: 14, nearTermIv: null }, // FAIL F3; no near-term IV
    earningsIvHistory: null,
  },
  // --- Sector-excluded demo stocks (fail Filter 1 in mock mode) ---
  {
    symbol: "XOM",
    company: "Exxon Mobil Corporation",
    price: 118.42,
    dailyChangePercent: 0.38,
    volume: 16_820_400,
    avgVolume: 15_340_000,
    marketCap: 472_000_000_000,
    impliedVolatility: 0.224,
    optionsVolume: 312_100,
    openInterest: 892_400,
    sector: "oil",
    nextEarningsDate: null,
    liquidityMetrics: null,
    earningsIvHistory: null,
  },
  {
    symbol: "UNH",
    company: "UnitedHealth Group Incorporated",
    price: 492.17,
    dailyChangePercent: -0.82,
    volume: 4_218_300,
    avgVolume: 3_940_000,
    marketCap: 456_000_000_000,
    impliedVolatility: 0.284,
    optionsVolume: 98_400,
    openInterest: 312_700,
    sector: "healthcare",
    nextEarningsDate: null,
    liquidityMetrics: null,
    earningsIvHistory: null,
  },
  {
    symbol: "AMGN",
    company: "Amgen Inc.",
    price: 312.84,
    dailyChangePercent: 1.14,
    volume: 3_128_400,
    avgVolume: 2_840_000,
    marketCap: 168_000_000_000,
    impliedVolatility: 0.261,
    optionsVolume: 84_200,
    openInterest: 248_300,
    sector: "biotech",
    nextEarningsDate: null,
    liquidityMetrics: null,
    earningsIvHistory: null,
  },
];

function mockOptionsChain(symbol: string): OptionsChain {
  const quote = MOCK_STOCKS.find((s) => s.symbol === symbol);
  const basePrice = quote?.price ?? 100;

  const expirations = [
    "2026-08-15",
    "2026-09-19",
    "2026-10-17",
    "2026-11-21",
    "2026-12-19",
  ];

  const strikes = [
    Math.round(basePrice * 0.85),
    Math.round(basePrice * 0.9),
    Math.round(basePrice * 0.95),
    Math.round(basePrice),
    Math.round(basePrice * 1.05),
    Math.round(basePrice * 1.1),
    Math.round(basePrice * 1.15),
  ];

  const contracts: OptionsContract[] = [];
  for (const expiration of expirations.slice(0, 2)) {
    for (const strike of strikes) {
      const moneyness = (basePrice - strike) / basePrice;
      const iv = (quote?.impliedVolatility ?? 0.3) + Math.random() * 0.1;

      contracts.push({
        strike,
        expiration,
        callBid: Math.max(0, parseFloat((basePrice - strike + 2).toFixed(2))),
        callAsk: Math.max(0, parseFloat((basePrice - strike + 2.5).toFixed(2))),
        callVolume: Math.floor(Math.random() * 5000 + 100),
        callOI: Math.floor(Math.random() * 20000 + 500),
        callIV: parseFloat(iv.toFixed(3)),
        callDelta: parseFloat(Math.max(0, Math.min(1, 0.5 + moneyness * 2)).toFixed(3)),
        callGamma: parseFloat((0.02 + Math.random() * 0.03).toFixed(4)),
        callTheta: parseFloat((-0.05 - Math.random() * 0.1).toFixed(4)),
        callVega: parseFloat((0.1 + Math.random() * 0.2).toFixed(4)),
        putBid: Math.max(0, parseFloat((strike - basePrice + 2).toFixed(2))),
        putAsk: Math.max(0, parseFloat((strike - basePrice + 2.5).toFixed(2))),
        putVolume: Math.floor(Math.random() * 3000 + 100),
        putOI: Math.floor(Math.random() * 15000 + 500),
        putIV: parseFloat((iv + 0.02).toFixed(3)),
        putDelta: parseFloat(Math.max(-1, Math.min(0, -0.5 + moneyness * 2)).toFixed(3)),
        putGamma: parseFloat((0.02 + Math.random() * 0.03).toFixed(4)),
        putTheta: parseFloat((-0.04 - Math.random() * 0.08).toFixed(4)),
        putVega: parseFloat((0.09 + Math.random() * 0.18).toFixed(4)),
      });
    }
  }

  return { symbol, expirations, contracts };
}

function mockMarketStatus(): MarketStatusData {
  const now = new Date();
  const hour = now.getUTCHours();
  const dayOfWeek = now.getUTCDay();

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      state: "closed",
      label: "CLOSED",
      description: "Market closed — weekend",
      timestamp: now,
      nextOpen: null,
      nextClose: null,
    };
  }
  if (hour >= 9 && hour < 14) {
    return {
      state: "pre_market",
      label: "PRE-MARKET",
      description: "Pre-market trading session (4:00 AM – 9:30 AM ET)",
      timestamp: now,
      nextOpen: null,
      nextClose: null,
    };
  }
  if (hour >= 14 && hour < 21) {
    return {
      state: "open",
      label: "OPEN",
      description: "Regular trading session (9:30 AM – 4:00 PM ET)",
      timestamp: now,
      nextOpen: null,
      nextClose: null,
    };
  }
  return {
    state: "after_hours",
    label: "AFTER-HOURS",
    description: "After-hours trading session (4:00 PM – 8:00 PM ET)",
    timestamp: now,
    nextOpen: null,
    nextClose: null,
  };
}

// MOCK IMPLEMENTATION — safe to use in development without any API key
export class MockMarketDataProvider implements IMarketDataProvider {
  readonly providerName = "MockMarketDataProvider";

  async getStockUniverse(): Promise<StockUniverseResult> {
    return {
      stocks: MOCK_STOCKS.map((s) => ({
        ...s,
        price: parseFloat((s.price * (1 + (Math.random() - 0.5) * 0.002)).toFixed(2)),
        dailyChangePercent: parseFloat(
          (s.dailyChangePercent + (Math.random() - 0.5) * 0.1).toFixed(2)
        ),
      })),
      dataFreshness: {
        timestamp: new Date().toISOString(),
        source: "live",
      },
    };
  }

  async getStockQuote(symbol: string): Promise<StockQuote | null> {
    const stock = MOCK_STOCKS.find((s) => s.symbol === symbol);
    if (!stock) return null;
    return {
      ...stock,
      price: parseFloat((stock.price * (1 + (Math.random() - 0.5) * 0.002)).toFixed(2)),
    };
  }

  async getOptionsChain(symbol: string): Promise<OptionsChain | null> {
    const exists = MOCK_STOCKS.some((s) => s.symbol === symbol);
    if (!exists) return null;
    return mockOptionsChain(symbol);
  }

  async getMarketStatus(): Promise<MarketStatusData> {
    return mockMarketStatus();
  }
}

// ---------------------------------------------------------------------------
// LIVE MARKET DATA — Polygon.io implementation
// ---------------------------------------------------------------------------

/**
 * Curated universe of high-liquidity, optionable US equities and ETFs.
 * Edit this list to change which symbols appear in the screener.
 */
export const LIVE_STOCK_UNIVERSE: string[] = [
  // Mega-cap tech
  "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "AMZN", "META", "TSLA",
  // Semiconductors
  "AMD", "INTC", "QCOM", "AVGO", "MU", "AMAT", "LRCX", "KLAC", "TSM",
  // Finance
  "JPM", "BAC", "GS", "MS", "C", "WFC", "BLK", "SCHW",
  // Healthcare
  "UNH", "LLY", "JNJ", "ABBV", "MRK", "PFE", "AMGN",
  // Consumer / Retail
  "WMT", "COST", "HD", "TGT", "NKE", "SBUX",
  // Energy
  "XOM", "CVX", "OXY",
  // High-vol / momentum names
  "COIN", "MSTR", "PLTR", "RBLX", "SNAP", "UBER", "LYFT", "HOOD",
  "RIVN", "LCID", "NIO", "XPEV", "BIDU", "BABA", "JD",
  // ETFs (highly optionable)
  "SPY", "QQQ", "IWM", "ARKK", "GLD", "SLV", "TLT", "HYG",
  // Volatility / macro
  "VIXY", "SQQQ", "TQQQ", "SPXS", "SPXL",
];

/**
 * Static display names for the curated universe.
 * Avoids a per-ticker reference API call on every universe fetch.
 */
const TICKER_NAMES: Record<string, string> = {
  AAPL: "Apple Inc.",
  MSFT: "Microsoft Corporation",
  NVDA: "NVIDIA Corporation",
  GOOGL: "Alphabet Inc. Class A",
  GOOG: "Alphabet Inc. Class C",
  AMZN: "Amazon.com, Inc.",
  META: "Meta Platforms, Inc.",
  TSLA: "Tesla, Inc.",
  AMD: "Advanced Micro Devices, Inc.",
  INTC: "Intel Corporation",
  QCOM: "Qualcomm Incorporated",
  AVGO: "Broadcom Inc.",
  MU: "Micron Technology, Inc.",
  AMAT: "Applied Materials, Inc.",
  LRCX: "Lam Research Corporation",
  KLAC: "KLA Corporation",
  TSM: "Taiwan Semiconductor Mfg. Co.",
  JPM: "JPMorgan Chase & Co.",
  BAC: "Bank of America Corporation",
  GS: "Goldman Sachs Group, Inc.",
  MS: "Morgan Stanley",
  C: "Citigroup Inc.",
  WFC: "Wells Fargo & Company",
  BLK: "BlackRock, Inc.",
  SCHW: "Charles Schwab Corporation",
  UNH: "UnitedHealth Group Incorporated",
  LLY: "Eli Lilly and Company",
  JNJ: "Johnson & Johnson",
  ABBV: "AbbVie Inc.",
  MRK: "Merck & Co., Inc.",
  PFE: "Pfizer Inc.",
  AMGN: "Amgen Inc.",
  WMT: "Walmart Inc.",
  COST: "Costco Wholesale Corporation",
  HD: "Home Depot, Inc.",
  TGT: "Target Corporation",
  NKE: "Nike, Inc.",
  SBUX: "Starbucks Corporation",
  XOM: "Exxon Mobil Corporation",
  CVX: "Chevron Corporation",
  OXY: "Occidental Petroleum Corporation",
  COIN: "Coinbase Global, Inc.",
  MSTR: "MicroStrategy Incorporated",
  PLTR: "Palantir Technologies Inc.",
  RBLX: "Roblox Corporation",
  SNAP: "Snap Inc.",
  UBER: "Uber Technologies, Inc.",
  LYFT: "Lyft, Inc.",
  HOOD: "Robinhood Markets, Inc.",
  RIVN: "Rivian Automotive, Inc.",
  LCID: "Lucid Group, Inc.",
  NIO: "NIO Inc.",
  XPEV: "XPeng Inc.",
  BIDU: "Baidu, Inc.",
  BABA: "Alibaba Group Holding Limited",
  JD: "JD.com, Inc.",
  SPY: "SPDR S&P 500 ETF Trust",
  QQQ: "Invesco QQQ Trust",
  IWM: "iShares Russell 2000 ETF",
  ARKK: "ARK Innovation ETF",
  GLD: "SPDR Gold Shares",
  SLV: "iShares Silver Trust",
  TLT: "iShares 20+ Year Treasury Bond ETF",
  HYG: "iShares iBoxx $ High Yield Corporate Bond ETF",
  VIXY: "ProShares VIX Short-Term Futures ETF",
  SQQQ: "ProShares UltraPro Short QQQ",
  TQQQ: "ProShares UltraPro QQQ",
  SPXS: "Direxion Daily S&P 500 Bear 3X Shares",
  SPXL: "Direxion Daily S&P 500 Bull 3X Shares",
};

/**
 * Sector classification for every symbol in the screener universe.
 * Used by Filter 1 to exclude oil, biotech, healthcare, and military defense.
 *
 * Excluded sectors: "oil" | "biotech" | "healthcare" | "defense"
 */
const TICKER_SECTORS: Record<string, string> = {
  // Mega-cap tech
  AAPL: "tech", MSFT: "tech", NVDA: "tech", GOOGL: "tech", GOOG: "tech",
  AMZN: "tech", META: "tech",
  // Automotive / EV
  TSLA: "automotive", RIVN: "automotive", LCID: "automotive",
  NIO: "automotive", XPEV: "automotive",
  // Semiconductors
  AMD: "tech", INTC: "tech", QCOM: "tech", AVGO: "tech", MU: "tech",
  AMAT: "tech", LRCX: "tech", KLAC: "tech", TSM: "tech",
  // Finance
  JPM: "finance", BAC: "finance", GS: "finance", MS: "finance",
  C: "finance", WFC: "finance", BLK: "finance", SCHW: "finance",
  // Healthcare (insurance + broad pharma) — EXCLUDED
  UNH: "healthcare", JNJ: "healthcare", MRK: "healthcare", PFE: "healthcare",
  // Biotech / biopharmaceutical — EXCLUDED
  LLY: "biotech", ABBV: "biotech", AMGN: "biotech",
  // Consumer / Retail
  WMT: "consumer", COST: "consumer", HD: "consumer", TGT: "consumer",
  NKE: "consumer", SBUX: "consumer",
  // Oil & Energy — EXCLUDED
  XOM: "oil", CVX: "oil", OXY: "oil",
  // Tech / fintech / high-vol
  COIN: "tech", MSTR: "tech", PLTR: "tech", RBLX: "tech", SNAP: "tech",
  UBER: "tech", LYFT: "tech", HOOD: "tech",
  // China tech
  BIDU: "tech", BABA: "tech", JD: "tech",
  // ETFs
  SPY: "etf", QQQ: "etf", IWM: "etf", ARKK: "etf", GLD: "etf",
  SLV: "etf", TLT: "etf", HYG: "etf", VIXY: "etf", SQQQ: "etf",
  TQQQ: "etf", SPXS: "etf", SPXL: "etf",
};

// ---------------------------------------------------------------------------
// Polygon.io response shapes (only fields the provider reads)
// ---------------------------------------------------------------------------

interface PolygonTickerSnapshot {
  ticker: string;
  day?: { v?: number; c?: number };
  prevDay?: { v?: number; c?: number };
  lastTrade?: { p?: number };
  lastQuote?: { P?: number };
  todaysChangePerc?: number;
}

interface PolygonSnapshotResponse {
  tickers?: PolygonTickerSnapshot[];
  status?: string;
}

interface PolygonAggregatesResponse {
  results?: Array<{ v?: number; c?: number; t?: number }>;
  status?: string;
}

/**
 * Polygon /v3/snapshot/options/{underlyingAsset} single result.
 *
 * Per Polygon docs:
 *   result.implied_volatility  — top-level float (NOT inside greeks or last_quote)
 *   result.open_interest       — top-level integer
 *   result.day.volume          — daily contract volume
 *   result.greeks.*            — Greeks (paid plans only; absent on free tier)
 */
interface PolygonOptionsResult {
  implied_volatility?: number;  // top-level per Polygon docs
  open_interest?: number;       // top-level per Polygon docs
  details?: {
    strike_price?: number;
    expiration_date?: string;
    contract_type?: "call" | "put";
  };
  day?: { volume?: number };
  greeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
  };
  last_quote?: { bid?: number; ask?: number };
}

interface PolygonOptionsResponse {
  results?: PolygonOptionsResult[];
  next_url?: string;
  status?: string;
}

interface PolygonMarketStatus {
  market?: string;
  afterHours?: boolean;
  earlyHours?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeNum(v: number | undefined, fallback = 0): number {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0]!;
}

/**
 * Returns true if the given YYYY-MM-DD date is the 3rd Friday of its month.
 * Monthly equity options expire on the 3rd Friday; anything else is a weekly.
 */
function isThirdFriday(dateStr: string): boolean {
  const d = new Date(dateStr + "T12:00:00Z");
  if (d.getUTCDay() !== 5) return false; // not a Friday
  const day = d.getUTCDate();
  return day >= 15 && day <= 21;
}

/**
 * Returns true if `price` is NOT an exact multiple of $0.05
 * (i.e., uses penny-increment quoting rather than nickel-only).
 */
function isPennyIncrement(price: number): boolean {
  return Math.round(price * 100) % 5 !== 0;
}

/**
 * Returns a YYYY-MM-DD string offset by `days` from a given ISO date string.
 * Positive = forward, negative = backward.
 */
function dateOffsetFrom(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0]!;
}

/**
 * Computes annualized close-to-close realized volatility from an array of
 * daily closing prices. Returns 0 when there are fewer than 3 data points.
 */
function realizedVol(closes: number[]): number {
  if (closes.length < 3) return 0;
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const cur  = closes[i]!;
    if (prev > 0 && cur > 0) logReturns.push(Math.log(cur / prev));
  }
  if (logReturns.length < 2) return 0;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / logReturns.length;
  return Math.sqrt(variance * 252); // annualize: √(daily variance × 252 trading days)
}

// ---------------------------------------------------------------------------
// PolygonRateLimiter
//
// Token-bucket that serialises outgoing requests to ≤ requestsPerMinute.
// Each call to acquire() resolves only when a slot is available.
// ---------------------------------------------------------------------------

class PolygonRateLimiter {
  private readonly minIntervalMs: number;
  private lastReleaseMs = 0;
  private readonly queue: Array<() => void> = [];
  private draining = false;

  constructor(requestsPerMinute: number) {
    this.minIntervalMs = Math.ceil(60_000 / requestsPerMinute);
  }

  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    this.tick();
  }

  private tick(): void {
    const next = this.queue[0];
    if (!next) {
      this.draining = false;
      return;
    }
    const now = Date.now();
    const wait = Math.max(0, this.lastReleaseMs + this.minIntervalMs - now);
    setTimeout(() => {
      this.queue.shift();
      this.lastReleaseMs = Date.now();
      next();
      this.tick();
    }, wait);
  }
}

// ---------------------------------------------------------------------------
// Universe cache entry
// ---------------------------------------------------------------------------

interface UniverseCache {
  data: StockQuote[];
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// LiveMarketDataProvider
// ---------------------------------------------------------------------------

export class LiveMarketDataProvider implements IMarketDataProvider {
  readonly providerName = "LiveMarketDataProvider (Polygon.io)";
  private readonly baseUrl = "https://api.polygon.io";

  /** null = unlimited (used in tests) */
  private readonly limiter: PolygonRateLimiter | null;

  private readonly cacheTtlMs: number;

  /** Most recently populated universe snapshot */
  private universeCache: UniverseCache | null = null;

  /**
   * True when the last background refresh attempt failed and the cache
   * is serving stale data.  Reset to false when a refresh succeeds.
   */
  private universeRefreshFailed = false;

  /**
   * In-flight refresh promise — deduplicates concurrent refresh requests
   * so only one enrichment cycle runs at a time.
   */
  private universeRefreshing: Promise<void> | null = null;

  /**
   * @param apiKey              Polygon.io API key
   * @param requestsPerMinute   Rate limit (5 = free tier; 0 = unlimited / tests only)
   * @param cacheTtlSeconds     How long the universe cache stays fresh (default 300 s)
   */
  constructor(
    private readonly apiKey: string,
    requestsPerMinute: number,
    cacheTtlSeconds: number
  ) {
    this.limiter =
      requestsPerMinute > 0 ? new PolygonRateLimiter(requestsPerMinute) : null;
    this.cacheTtlMs = cacheTtlSeconds * 1000;

    // Pre-warm the universe cache in the background at startup.
    // Errors are swallowed here; the first getStockUniverse() call will
    // surface them if the cache is still empty.
    this.refreshUniverseCache().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Universe cache management
  // -------------------------------------------------------------------------

  /**
   * Triggers a background universe refresh if one is not already running.
   * Returns a promise that resolves when the refresh finishes (or rejects on
   * failure), so callers on the cold-start path can await it.
   *
   * If the fetch fails and a stale cache exists, the error is swallowed here:
   * the cache is preserved and `universeRefreshFailed` is set to true so that
   * `getStockUniverse()` can surface a staleness flag to callers.
   * If the fetch fails and the cache is empty (cold-start), the error propagates
   * so the caller can surface a meaningful error to the user.
   */
  private refreshUniverseCache(): Promise<void> {
    if (this.universeRefreshing) return this.universeRefreshing;

    this.universeRefreshing = this.fetchUniverseFromPolygon()
      .then((data) => {
        this.universeCache = { data, fetchedAt: Date.now() };
        this.universeRefreshFailed = false;
      })
      .catch((err: unknown) => {
        if (this.universeCache) {
          // Stale cache exists — serve it with a staleness flag rather than failing.
          this.universeRefreshFailed = true;
          const msg = err instanceof Error ? err.message : String(err);
          // Log inline since we can't import logger (circular dep risk); use console.warn.
          console.warn(`[LiveMarketDataProvider] Universe refresh failed; serving stale cache. Reason: ${msg}`);
        } else {
          // No cache at all — propagate so the cold-start caller can surface the error.
          throw err;
        }
      })
      .finally(() => {
        this.universeRefreshing = null;
      });

    return this.universeRefreshing;
  }

  /**
   * Stale-while-revalidate cache strategy:
   *
   * - Cache is FRESH  → return immediately.
   * - Cache is STALE  → return stale data immediately; kick off background refresh.
   * - Cache is EMPTY  → await first populate (slow on free tier — this is the
   *                     only blocking path, and only occurs once at cold start).
   *
   * Because POST /scanner/run fires-and-forgets the scan (the HTTP response is
   * sent before the scan executes), the slow cold-start path never blocks an
   * HTTP request.  Callers of getStockUniverse() from within the background
   * scan task will block until data is ready, which is the intended behaviour.
   */
  async getStockUniverse(): Promise<StockUniverseResult> {
    const cache = this.universeCache;

    if (cache) {
      const isStale = Date.now() - cache.fetchedAt >= this.cacheTtlMs;
      if (isStale && !this.universeRefreshing) {
        // Stale-while-revalidate: return immediately, refresh in background.
        this.refreshUniverseCache().catch(() => {});
      }
      // Any data past its TTL is reported as "cached" — the consumer (scanner)
      // sees this flag immediately on the first stale call, before the background
      // refresh attempt even completes.  This avoids a race where an upstream
      // failure is not surfaced until the second stale call.
      return {
        stocks: cache.data,
        dataFreshness: {
          timestamp: new Date(cache.fetchedAt).toISOString(),
          source: isStale ? "cached" : "live",
        },
      };
    }

    // Cold start: wait for the first populate.
    await this.refreshUniverseCache();
    const fresh = this.universeCache;
    if (!fresh || fresh.data.length === 0) {
      throw new Error(
        "LiveMarketDataProvider: universe cache is empty after first populate. " +
          "Verify MARKET_DATA_API_KEY is valid and the Polygon.io API is reachable."
      );
    }
    return {
      stocks: fresh.data,
      dataFreshness: {
        timestamp: new Date(fresh.fetchedAt).toISOString(),
        source: "live",
      },
    };
  }

  // -------------------------------------------------------------------------
  // Low-level HTTP helpers
  // -------------------------------------------------------------------------

  /**
   * Rate-limited, retry-aware single-URL fetch.
   *
   * - Acquires a rate-limiter token before each attempt (skipped when limiter is null).
   * - On HTTP 429: waits for Retry-After then retries (up to MAX_RETRIES total).
   * - On other non-OK responses: throws immediately (non-recoverable).
   */
  private async fetchUrl<T>(url: URL): Promise<T> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (this.limiter) await this.limiter.acquire();

      const res = await fetch(url.toString());

      if (res.status === 429) {
        const retryAfterSec = parseInt(res.headers.get("Retry-After") ?? "60", 10);
        await sleep(retryAfterSec * 1000);
        continue; // retry — uses the same attempt slot
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "(no body)");
        throw new Error(
          `Polygon ${res.status} for ${url.pathname}: ${res.statusText} — ${body}`
        );
      }

      return res.json() as Promise<T>;
    }

    throw new Error(
      `Polygon: ${MAX_RETRIES} retries exhausted for ${url.pathname}`
    );
  }

  /** Build a Polygon REST URL from a path + query params (apiKey auto-appended). */
  private buildUrl(path: string, params: Record<string, string> = {}): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("apiKey", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return url;
  }

  private async polygonFetch<T>(
    path: string,
    params: Record<string, string> = {}
  ): Promise<T> {
    return this.fetchUrl<T>(this.buildUrl(path, params));
  }

  /**
   * Fully paginate a Polygon v3 endpoint.
   *
   * Every page — including next_url continuations — goes through fetchUrl so
   * that rate limiting and bounded retry semantics apply uniformly.  A
   * non-recoverable error on any page propagates to the caller; no partial
   * results are returned silently.
   *
   * Callers are responsible for constraining the result set (e.g. via
   * expiration_date filters) so pagination terminates within a reasonable
   * number of pages.
   */
  private async polygonFetchAllPages<
    T extends { results?: unknown[]; next_url?: string }
  >(
    path: string,
    params: Record<string, string> = {}
  ): Promise<NonNullable<T["results"]>> {
    const allResults: unknown[] = [];
    let nextUrl: URL | undefined = this.buildUrl(path, params);

    while (nextUrl) {
      const data: T = await this.fetchUrl<T>(nextUrl);
      if (data.results) allResults.push(...data.results);

      if (data.next_url) {
        // next_url already carries all query params; only add apiKey.
        const u = new URL(data.next_url);
        u.searchParams.set("apiKey", this.apiKey);
        nextUrl = u;
      } else {
        nextUrl = undefined;
      }
    }

    return allResults as NonNullable<T["results"]>;
  }

  // -------------------------------------------------------------------------
  // Per-ticker enrichment helpers (used by fetchUniverseFromPolygon)
  // -------------------------------------------------------------------------

  /**
   * Fetch representative options stats for one ticker.
   *
   * Fetches one page (250 contracts) sorted by open_interest descending —
   * the most liquid contracts within the next 90 days.  This is a bounded
   * sample: for large tickers (e.g. SPY) the market totals are much higher,
   * but the sample is sufficient for the screening filter pass/fail thresholds.
   *
   * Uses the top-level `implied_volatility` and `open_interest` fields per
   * the Polygon v3 options snapshot API specification.
   *
   * Throws on failure so the caller can drop this ticker rather than
   * filling filter inputs with zeros.
   */
  /**
   * Fetches the last 4 quarterly earnings dates and 220 days of daily price
   * data, then computes annualized realized-volatility for the pre-earnings
   * window (days −7 to −2 before earnings) vs. a baseline window (days −40
   * to −15 before earnings) for each cycle.
   *
   * Returns an array of 4 EarningsIvRecord entries, or null if fewer than 4
   * cycles of usable data exist. Degrades gracefully on any API error.
   *
   * NOTE: Realized volatility is used as an honest proxy for implied volatility
   * because Polygon's standard aggregates endpoint does not expose historical
   * options IV. RV and IV are directionally correlated around earnings events.
   */
  private async fetchEarningsIvHistory(ticker: string): Promise<EarningsIvRecord[] | null> {
    try {
      // Step 1: get last 4 quarterly filing dates (≈ earnings announcement dates)
      const financials = await this.polygonFetch<{
        results?: Array<{ filing_date?: string; period_of_report_date?: string }>;
      }>("/vX/reference/financials", {
        ticker,
        timeframe: "quarterly",
        limit: "4",
        sort: "period_of_report_date",
        order: "desc",
      });

      const filings = (financials.results ?? [])
        .map((r) => r.filing_date ?? r.period_of_report_date)
        .filter((d): d is string => !!d);

      if (filings.length < 4) return null;

      // Step 2: single price-data fetch covering the full 220-day window
      const earliest = filings[filings.length - 1]!;
      const priceFrom = dateOffsetFrom(earliest, -50); // extra buffer for baseline
      const priceTo   = dateOffsetFrom(filings[0]!, -1);

      const aggs = await this.polygonFetch<PolygonAggregatesResponse>(
        `/v2/aggs/ticker/${ticker}/range/1/day/${priceFrom}/${priceTo}`,
        { adjusted: "true", sort: "asc", limit: "250" }
      );

      const bars = (aggs.results ?? []).filter((b) => b.t && b.c);

      // Step 3: compute realized vol windows around each filing date
      const records: EarningsIvRecord[] = [];

      for (const earningsDate of filings) {
        const earningsTs = new Date(earningsDate + "T00:00:00").getTime();

        // Collect closes in two windows (by timestamp proximity)
        const preCloses: number[]  = [];
        const baseCloses: number[] = [];

        for (const bar of bars) {
          const barDate = new Date(bar.t!).toISOString().split("T")[0]!;
          const daysTo = Math.round(
            (earningsTs - new Date(barDate + "T00:00:00").getTime()) / 86_400_000
          );
          if (daysTo >= 2  && daysTo <= 7)  preCloses.push(bar.c!);
          if (daysTo >= 15 && daysTo <= 40) baseCloses.push(bar.c!);
        }

        const ivBefore   = realizedVol(preCloses);
        const ivBaseline = realizedVol(baseCloses);

        if (ivBefore === 0 || ivBaseline === 0) continue; // not enough price data

        records.push({
          earningsDate,
          ivBeforeEarnings: parseFloat(ivBefore.toFixed(4)),
          ivBaseline:       parseFloat(ivBaseline.toFixed(4)),
          ivRose:           ivBefore > ivBaseline,
        });
      }

      return records.length >= 4 ? records : null;
    } catch {
      return null;
    }
  }

  /**
   * Estimate the next earnings date for a ticker by fetching its most recent
   * quarterly filing date from Polygon's financials endpoint and projecting
   * forward ~91 days (one fiscal quarter).
   *
   * Returns null on any error so the caller can degrade gracefully — a null
   * nextEarningsDate causes Filter 2 (upcoming earnings) to FAIL for that stock.
   */
  private async fetchNextEarningsDate(ticker: string): Promise<string | null> {
    try {
      const data = await this.polygonFetch<{
        results?: Array<{ filing_date?: string; period_of_report_date?: string }>;
      }>("/vX/reference/financials", {
        ticker,
        timeframe: "quarterly",
        limit: "1",
        sort: "period_of_report_date",
        order: "desc",
      });

      const result = data.results?.[0];
      if (!result) return null;

      // Prefer the actual filing date (closer to earnings announcement)
      // over the period end date (which is weeks earlier).
      const baseDate = result.filing_date ?? result.period_of_report_date;
      if (!baseDate) return null;

      const next = new Date(baseDate + "T00:00:00");
      next.setDate(next.getDate() + 91); // one fiscal quarter forward
      return next.toISOString().split("T")[0]; // YYYY-MM-DD
    } catch {
      return null;
    }
  }

  private async fetchOptionsStats(ticker: string): Promise<{
    optionsVolume: number;
    openInterest: number;
    impliedVolatility: number;
    liquidityMetrics: OptionsLiquidityMetrics;
  }> {
    const data = await this.polygonFetch<PolygonOptionsResponse>(
      `/v3/snapshot/options/${ticker}`,
      {
        limit: "250",
        sort: "open_interest",
        order: "desc",
        "expiration_date.gte": dateOffset(0),
        "expiration_date.lte": dateOffset(90),
      }
    );

    const results = data.results ?? [];
    if (results.length === 0) {
      throw new Error(`No options data for ${ticker}`);
    }

    let optionsVolume = 0;
    let openInterest = 0;
    const ivValues: number[] = [];

    // --- Liquidity metrics (Filter 3) ---
    const expiryDates = new Set<string>();
    const byExpiry = new Map<string, PolygonOptionsResult[]>();

    for (const r of results) {
      optionsVolume += safeNum(r.day?.volume);
      openInterest += safeNum(r.open_interest);
      const iv = safeNum(r.implied_volatility);
      if (iv > 0) ivValues.push(iv);

      const expiry = r.details?.expiration_date;
      if (expiry) {
        expiryDates.add(expiry);
        if (!byExpiry.has(expiry)) byExpiry.set(expiry, []);
        byExpiry.get(expiry)!.push(r);
      }
    }

    // Rule 1 — weekly options: any Friday that is NOT the 3rd Friday of the month
    const hasWeeklyOptions = [...expiryDates].some((d) => !isThirdFriday(d));

    // Rule 2 — penny increments: any $0.20–$0.70 option with a non-nickel bid or ask
    const hasPennyIncrements = results.some((r) => {
      const bid = r.last_quote?.bid ?? 0;
      const ask = r.last_quote?.ask ?? 0;
      const mid = (bid + ask) / 2;
      return mid >= 0.2 && mid <= 0.7 && (isPennyIncrement(bid) || isPennyIncrement(ask));
    });

    // Rules 3 & 4 — find the expiry closest to 11 DTE
    const todayMs = new Date().setHours(0, 0, 0, 0);
    let nearTermExpiry: string | null = null;
    let nearTermDte: number | null = null;
    let minDiff = Infinity;

    for (const expiry of expiryDates) {
      const dte = Math.round(
        (new Date(expiry + "T00:00:00").getTime() - todayMs) / 86_400_000
      );
      if (dte < 0) continue;
      const diff = Math.abs(dte - 11);
      if (diff < minDiff) { minDiff = diff; nearTermExpiry = expiry; nearTermDte = dte; }
    }

    let nearTermSpread: number | null = null;
    if (nearTermExpiry) {
      const spreads = (byExpiry.get(nearTermExpiry) ?? [])
        .filter((r) => {
          const bid = r.last_quote?.bid ?? 0;
          const ask = r.last_quote?.ask ?? 0;
          return (bid + ask) / 2 >= 0.2 && (bid + ask) / 2 <= 0.7 && ask > bid;
        })
        .map((r) => r.last_quote!.ask! - r.last_quote!.bid!);

      if (spreads.length > 0) {
        nearTermSpread = parseFloat(
          (spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(3)
        );
      }
    }

    // Near-term IV: median IV from contracts in the near-term expiry bucket
    let nearTermIv: number | null = null;
    if (nearTermExpiry) {
      const nearIvValues = (byExpiry.get(nearTermExpiry) ?? [])
        .map((r) => safeNum(r.implied_volatility))
        .filter((iv) => iv > 0);
      if (nearIvValues.length > 0) {
        nearTermIv = parseFloat(median(nearIvValues).toFixed(4));
      }
    }

    return {
      optionsVolume,
      openInterest,
      impliedVolatility: median(ivValues),
      liquidityMetrics: { hasWeeklyOptions, hasPennyIncrements, nearTermSpread, nearTermDte, nearTermIv },
    };
  }

  /**
   * Fetch 30-day historical average daily volume for one ticker.
   * Throws on failure so the caller can handle the absence of data.
   */
  private async fetchAvgVolume(ticker: string): Promise<number> {
    const toDate = dateOffset(0);
    const fromDate = dateOffset(-35);

    const data = await this.polygonFetch<PolygonAggregatesResponse>(
      `/v2/aggs/ticker/${ticker}/range/1/day/${fromDate}/${toDate}`,
      { adjusted: "true", sort: "asc", limit: "30" }
    );

    const bars = data.results ?? [];
    if (bars.length === 0) throw new Error(`No aggregates for ${ticker}`);
    const totalVol = bars.reduce((sum, b) => sum + safeNum(b.v), 0);
    return Math.round(totalVol / bars.length);
  }

  // -------------------------------------------------------------------------
  // Full universe fetch (runs in background, populates cache)
  // -------------------------------------------------------------------------

  /**
   * Fetch all universe data from Polygon.  This is the slow path that
   * runs as a background task; it is never called synchronously from the
   * scan route.
   *
   * Tickers whose enrichment fails after retries are DROPPED from results
   * so the screener never receives zero-valued filter inputs masquerading
   * as real data.
   */
  private async fetchUniverseFromPolygon(): Promise<StockQuote[]> {
    // 1. Batch snapshot: price, today's volume, daily change — 1 API call
    const tickers = LIVE_STOCK_UNIVERSE.join(",");
    const snapData = await this.polygonFetch<PolygonSnapshotResponse>(
      "/v2/snapshot/locale/us/markets/stocks/tickers",
      { tickers }
    );
    const snaps = snapData.tickers ?? [];

    // 2. Per-ticker enrichment in parallel (rate limiter controls throughput)
    const enriched: StockQuote[] = [];

    await Promise.all(
      snaps.map(async (snap) => {
        try {
          const price =
            safeNum(snap.lastTrade?.p) ||
            safeNum(snap.lastQuote?.P) ||
            safeNum(snap.day?.c) ||
            safeNum(snap.prevDay?.c);

          const [optStats, avgVol, nextEarningsDate, earningsIvHistory] = await Promise.all([
            this.fetchOptionsStats(snap.ticker),
            this.fetchAvgVolume(snap.ticker),
            this.fetchNextEarningsDate(snap.ticker),
            this.fetchEarningsIvHistory(snap.ticker),
          ]);

          enriched.push({
            symbol: snap.ticker,
            company: TICKER_NAMES[snap.ticker] ?? snap.ticker,
            price: parseFloat(price.toFixed(2)),
            dailyChangePercent: parseFloat(safeNum(snap.todaysChangePerc).toFixed(2)),
            volume: Math.round(safeNum(snap.day?.v)),
            avgVolume: avgVol,
            marketCap: 0,
            impliedVolatility: parseFloat(optStats.impliedVolatility.toFixed(4)),
            optionsVolume: optStats.optionsVolume,
            openInterest: optStats.openInterest,
            sector: TICKER_SECTORS[snap.ticker] ?? "other",
            nextEarningsDate,
            liquidityMetrics: optStats.liquidityMetrics,
            earningsIvHistory,
          });
        } catch {
          // Enrichment failed — drop this ticker rather than zero-filling.
          // This prevents false FAIL results in the screener filters.
        }
      })
    );

    return enriched;
  }

  // -------------------------------------------------------------------------
  // IMarketDataProvider — remaining methods
  // -------------------------------------------------------------------------

  async getStockQuote(symbol: string): Promise<StockQuote | null> {
    try {
      const [snapData, optStats, avgVol, nextEarningsDate, earningsIvHistory] = await Promise.all([
        this.polygonFetch<{ ticker?: PolygonTickerSnapshot }>(
          `/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`
        ),
        this.fetchOptionsStats(symbol),
        this.fetchAvgVolume(symbol),
        this.fetchNextEarningsDate(symbol),
        this.fetchEarningsIvHistory(symbol),
      ]);

      const snap = snapData.ticker;
      if (!snap) return null;

      const price =
        safeNum(snap.lastTrade?.p) ||
        safeNum(snap.lastQuote?.P) ||
        safeNum(snap.day?.c) ||
        safeNum(snap.prevDay?.c);

      return {
        symbol,
        company: TICKER_NAMES[symbol] ?? symbol,
        price: parseFloat(price.toFixed(2)),
        dailyChangePercent: parseFloat(safeNum(snap.todaysChangePerc).toFixed(2)),
        volume: Math.round(safeNum(snap.day?.v)),
        avgVolume: avgVol,
        marketCap: 0,
        impliedVolatility: parseFloat(optStats.impliedVolatility.toFixed(4)),
        optionsVolume: optStats.optionsVolume,
        openInterest: optStats.openInterest,
        sector: TICKER_SECTORS[symbol] ?? "other",
        nextEarningsDate,
        liquidityMetrics: optStats.liquidityMetrics,
        earningsIvHistory,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch the full options chain for a symbol.
   *
   * Constrained to a 6-month expiration window so that the result set is
   * bounded and relevant for near-term options strategies.  All pages within
   * that window are fully fetched with uniform retry semantics.
   *
   * Greeks (delta, gamma, theta, vega) are zero on the Polygon free tier;
   * they are populated on paid plans.
   */
  async getOptionsChain(symbol: string): Promise<OptionsChain | null> {
    try {
      const results = (await this.polygonFetchAllPages<PolygonOptionsResponse>(
        `/v3/snapshot/options/${symbol}`,
        {
          limit: "250",
          "expiration_date.gte": dateOffset(0),
          "expiration_date.lte": dateOffset(180),
        }
      )) as PolygonOptionsResult[];

      if (!results || results.length === 0) return null;

      const expirationSet = new Set<string>();
      const contractMap = new Map<
        string,
        { call?: PolygonOptionsResult; put?: PolygonOptionsResult }
      >();

      for (const r of results) {
        const exp = r.details?.expiration_date ?? "";
        const strike = r.details?.strike_price ?? 0;
        const type = r.details?.contract_type;
        if (!exp || !strike || !type) continue;

        expirationSet.add(exp);
        const key = `${exp}:${strike}`;
        const existing = contractMap.get(key) ?? {};
        contractMap.set(key, { ...existing, [type]: r });
      }

      const expirations = Array.from(expirationSet).sort();
      const contracts: OptionsContract[] = [];

      for (const [key, sides] of contractMap.entries()) {
        const colonIdx = key.indexOf(":");
        const exp = key.slice(0, colonIdx);
        const strike = parseFloat(key.slice(colonIdx + 1));
        if (!exp || !strike) continue;

        const call = sides.call;
        const put = sides.put;

        contracts.push({
          strike,
          expiration: exp,
          // implied_volatility is the top-level field per Polygon docs
          callBid: safeNum(call?.last_quote?.bid),
          callAsk: safeNum(call?.last_quote?.ask),
          callVolume: safeNum(call?.day?.volume),
          callOI: safeNum(call?.open_interest),
          callIV: safeNum(call?.implied_volatility),
          callDelta: safeNum(call?.greeks?.delta),
          callGamma: safeNum(call?.greeks?.gamma),
          callTheta: safeNum(call?.greeks?.theta),
          callVega: safeNum(call?.greeks?.vega),
          putBid: safeNum(put?.last_quote?.bid),
          putAsk: safeNum(put?.last_quote?.ask),
          putVolume: safeNum(put?.day?.volume),
          putOI: safeNum(put?.open_interest),
          putIV: safeNum(put?.implied_volatility),
          putDelta: safeNum(put?.greeks?.delta),
          putGamma: safeNum(put?.greeks?.gamma),
          putTheta: safeNum(put?.greeks?.theta),
          putVega: safeNum(put?.greeks?.vega),
        });
      }

      contracts.sort((a, b) => {
        const expCmp = a.expiration.localeCompare(b.expiration);
        return expCmp !== 0 ? expCmp : a.strike - b.strike;
      });

      return { symbol, expirations, contracts };
    } catch {
      return null;
    }
  }

  async getMarketStatus(): Promise<MarketStatusData> {
    const now = new Date();
    try {
      const data = await this.polygonFetch<PolygonMarketStatus>(
        "/v1/marketstatus/now"
      );
      const marketField = (data.market ?? "").toLowerCase();

      let state: MarketStatusData["state"];
      let label: string;
      let description: string;

      if (marketField === "open") {
        state = "open";
        label = "OPEN";
        description = "Regular trading session (9:30 AM – 4:00 PM ET)";
      } else if (data.earlyHours) {
        state = "pre_market";
        label = "PRE-MARKET";
        description = "Pre-market trading session (4:00 AM – 9:30 AM ET)";
      } else if (data.afterHours) {
        state = "after_hours";
        label = "AFTER-HOURS";
        description = "After-hours trading session (4:00 PM – 8:00 PM ET)";
      } else {
        state = "closed";
        label = "CLOSED";
        description = "Market closed";
      }

      return {
        state,
        label,
        description,
        timestamp: now,
        nextOpen: null,
        nextClose: null,
      };
    } catch {
      return mockMarketStatus();
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — reads env vars and returns the correct provider
// ---------------------------------------------------------------------------

export function createMarketDataProvider(): IMarketDataProvider {
  const mode = process.env.MARKET_DATA_PROVIDER ?? "mock";

  if (mode === "live") {
    const apiKey = process.env.MARKET_DATA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "MARKET_DATA_PROVIDER=live but MARKET_DATA_API_KEY is not set. " +
          "Add your Polygon.io API key to Replit Secrets."
      );
    }
    // Default 5 req/min = Polygon free tier.  Raise POLYGON_REQUESTS_PER_MINUTE
    // for paid plans (Starter supports ~100+).  Set to 0 for unlimited (tests only).
    // Default: 100 req/min — appropriate for Polygon Starter plan.
    // Free tier (5 RPM) cannot complete a 75-symbol universe in a useful time;
    // set POLYGON_REQUESTS_PER_MINUTE=5 explicitly to opt into the slow path.
    const rpm = parseInt(process.env.POLYGON_REQUESTS_PER_MINUTE ?? "100", 10);
    const cacheTtl = parseInt(process.env.UNIVERSE_CACHE_TTL_SECONDS ?? "300", 10);
    return new LiveMarketDataProvider(
      apiKey,
      isFinite(rpm) && rpm >= 0 ? rpm : 100,
      isFinite(cacheTtl) && cacheTtl > 0 ? cacheTtl : 300
    );
  }

  return new MockMarketDataProvider();
}
// NOTE: No singleton is exported here — the single shared instance is created
// by services.ts.  Importing createMarketDataProvider directly avoids
// accidentally constructing a second provider (and its background pre-warm).
