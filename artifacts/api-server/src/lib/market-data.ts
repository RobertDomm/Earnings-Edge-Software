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

import { getConfirmedEarningsDate } from "./earnings-calendar.js";

/** A structured upcoming corporate event that could rival earnings as a catalyst. */
export interface UpcomingCorporateEvent {
  type: "dividend" | "split";
  /** Event date (ex-dividend date or split execution date), YYYY-MM-DD. */
  date: string;
}

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
   * How nextEarningsDate was obtained:
   *   "confirmed" → from a real earnings calendar (announced date)
   *   "estimated" → derived from the last quarterly filing date + 91 days
   *   null        → no earnings date available (nextEarningsDate is null)
   * Optional so older cached/mocked quotes without the field remain valid.
   */
  earningsDateSource?: "confirmed" | "estimated" | null;
  /**
   * Known upcoming corporate events (ex-dividend dates, splits) between today
   * and shortly after earnings. Used by Filter 5 to verify earnings is the
   * only upcoming catalyst.
   *   []        → lookup succeeded, no events found
   *   null      → lookup failed or unavailable (Filter 5 bypasses the check)
   *   undefined → provider predates the field (treated like null)
   */
  upcomingEvents?: UpcomingCorporateEvent[] | null;
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
  /**
   * Strike price of the OTM call chosen for the short leg of the double calendar
   * (priced 30–60 cents at ~11 DTE). Null when no suitable contract was found.
   * Used by Filter 6.
   */
  shortCallStrike: number | null;
  /**
   * Strike price of the OTM put chosen for the short leg of the double calendar
   * (priced 30–60 cents at ~11 DTE). Null when no suitable contract was found.
   * Used by Filter 6.
   */
  shortPutStrike: number | null;
  /**
   * Peak P&L (in $) of the call-side calendar at the short's expiry, if the stock
   * lands exactly at shortCallStrike. Positive = peak above zero line (good).
   * = bsAtm(shortCallStrike, long18DteIV, 7d) − totalCalendarDebit
   * Null when data is insufficient. Used by Filter 6.
   */
  callCalendarPeak: number | null;
  /**
   * Peak P&L (in $) of the put-side calendar at the short's expiry, if the stock
   * lands exactly at shortPutStrike. Positive = peak above zero line (good).
   * = bsAtm(shortPutStrike, long18DteIV, 7d) − totalCalendarDebit
   * Null when data is insufficient. Used by Filter 6.
   */
  putCalendarPeak: number | null;
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

export const MOCK_STOCKS: StockQuote[] = [
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
    earningsDateSource: "confirmed",
    upcomingEvents: [],
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.17, nearTermDte: 11, nearTermIv: 0.451, shortCallStrike: 207.5, shortPutStrike: 172.5, callCalendarPeak: 1.24, putCalendarPeak: 0.98 },
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
    earningsDateSource: "confirmed",
    upcomingEvents: [],
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.62, nearTermDte: 9, nearTermIv: 0.548, shortCallStrike: null, shortPutStrike: null, callCalendarPeak: null, putCalendarPeak: null }, // FAIL F3 (spread)
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
    earningsDateSource: "confirmed",
    upcomingEvents: [],
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.22, nearTermDte: 11, nearTermIv: 0.214, shortCallStrike: 452.5, shortPutStrike: 377.5, callCalendarPeak: 2.87, putCalendarPeak: 2.41 }, // FAIL F2 (earnings 29d away)
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
    earningsDateSource: "confirmed",
    upcomingEvents: [],
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.27, nearTermDte: 12, nearTermIv: 0.948, shortCallStrike: 272.5, shortPutStrike: 225.0, callCalendarPeak: 3.82, putCalendarPeak: 3.14 }, // FAIL F4
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
    earningsDateSource: "confirmed",
    upcomingEvents: [],
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.31, nearTermDte: 10, nearTermIv: 0.521, shortCallStrike: 560.0, shortPutStrike: 467.5, callCalendarPeak: 3.42, putCalendarPeak: 2.91 },
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
    earningsDateSource: "confirmed",
    upcomingEvents: [],
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.24, nearTermDte: 9, nearTermIv: 0.281, shortCallStrike: 210.0, shortPutStrike: 177.5, callCalendarPeak: 1.48, putCalendarPeak: 1.22 }, // FAIL F2 (earnings 2d away)
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
    earningsDateSource: "confirmed",
    upcomingEvents: [],
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.22, nearTermDte: 12, nearTermIv: 0.847, shortCallStrike: 185.0, shortPutStrike: 152.5, callCalendarPeak: 2.31, putCalendarPeak: 1.87 },
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
    upcomingEvents: [],
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.05, nearTermDte: 7, nearTermIv: 0.145, shortCallStrike: null, shortPutStrike: null, callCalendarPeak: null, putCalendarPeak: null }, // ETF — no calendar structure
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
    earningsDateSource: "confirmed",
    upcomingEvents: [],
    liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: 0.19, nearTermDte: 14, nearTermIv: 0.419, shortCallStrike: 197.5, shortPutStrike: 162.5, callCalendarPeak: -0.43, putCalendarPeak: 1.18 }, // FAIL F6 — call peak below zero
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
    earningsDateSource: "confirmed",
    upcomingEvents: [],
    liquidityMetrics: { hasWeeklyOptions: false, hasPennyIncrements: false, nearTermSpread: 0.45, nearTermDte: 14, nearTermIv: null, shortCallStrike: null, shortPutStrike: null, callCalendarPeak: null, putCalendarPeak: null }, // FAIL F3
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
    upcomingEvents: [],
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
    upcomingEvents: [],
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
    upcomingEvents: [],
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

/**
 * Black-Scholes ATM option value approximation (call = put when S = K, r = 0).
 *
 * Derivation: when stock = strike and interest rate ≈ 0,
 *   d1 ≈ σ√T/2 ≈ 0 for small T  →  N(d1) ≈ N'(d1) ≈ 0.3989 (standard normal PDF at 0)
 *   C ≈ S × σ × √T × N'(0)  =  S × σ × √T × 0.3989422804
 *
 * Accurate to ~2% for typical short-dated options (T < 30 days) and normal IV levels.
 *
 * @param strike  The option strike price (= current stock price for ATM)
 * @param iv      Annualised implied volatility (e.g. 0.30 for 30%)
 * @param t       Time to expiry in years (e.g. 7/365 for 7 days)
 */
function bsAtmValue(strike: number, iv: number, t: number): number {
  return strike * iv * Math.sqrt(t) * 0.3989422804;
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
// Polygon earnings helper — shared by LiveMarketDataProvider and ThetaDataProvider
// ---------------------------------------------------------------------------

/** Error carrying the HTTP status of a failed Polygon request, so retry and
 *  log-classification logic can distinguish throttling / auth / server faults. */
class PolygonHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PolygonHttpError";
  }
}

/** Human-readable failure category for warn logs. */
function classifyPolygonError(err: unknown): string {
  if (err instanceof PolygonHttpError) {
    if (err.status === 429) return "throttled (429)";
    if (err.status === 401 || err.status === 403) return `auth error (${err.status}) — check MARKET_DATA_API_KEY`;
    if (err.status >= 500) return `Polygon server error (${err.status})`;
    return `HTTP ${err.status}`;
  }
  if (err instanceof SyntaxError) return "unexpected response shape (invalid JSON)";
  return "network error";
}

/** True for transient failures worth retrying: throttling, 5xx, network errors. */
function isRetryablePolygonError(err: unknown): boolean {
  if (err instanceof PolygonHttpError) return err.status === 429 || err.status >= 500;
  return !(err instanceof SyntaxError) && err instanceof Error && !(err instanceof PolygonHttpError);
}

export interface PolygonEarningsFetchOptions {
  /** Retries after the initial attempt for transient (429/5xx/network) failures. Default 2. */
  retries?: number;
  /** Base backoff in ms; attempt n waits retryBaseMs × 2ⁿ. Default 250. Tests pass 1. */
  retryBaseMs?: number;
}

/**
 * Fetches the last 4 quarterly earnings dates and realized-vol history from
 * Polygon.io for a single ticker.  Used by LiveMarketDataProvider directly and
 * by ThetaDataProvider (via fetchPolygonEarningsDataCached) when
 * MARKET_DATA_API_KEY is set.
 *
 * Failures never throw — they resolve with null fields — but every failure is
 * logged with the ticker and a classified reason (throttling / auth / server /
 * response shape), and transient failures are retried with backoff first.
 *
 * No rate limiter: callers are responsible for concurrency control.
 */
export async function fetchPolygonEarningsData(
  apiKey: string,
  ticker: string,
  opts: PolygonEarningsFetchOptions = {},
): Promise<{ nextEarningsDate: string | null; earningsIvHistory: EarningsIvRecord[] | null }> {
  const baseUrl = "https://api.polygon.io";
  const maxRetries = opts.retries ?? 2;
  const retryBaseMs = opts.retryBaseMs ?? 250;

  async function polyFetchOnce<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("apiKey", apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new PolygonHttpError(`Polygon ${res.status} for ${path}: ${res.statusText} — ${body}`, res.status);
    }
    return res.json() as Promise<T>;
  }

  /** polyFetchOnce + retry with exponential backoff on transient failures. */
  async function polyFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await polyFetchOnce<T>(path, params);
      } catch (err) {
        if (attempt >= maxRetries || !isRetryablePolygonError(err)) throw err;
        await new Promise((r) => setTimeout(r, retryBaseMs * 2 ** attempt));
      }
    }
  }

  // --- Step 1: financials (single call) ---
  let filings: string[];
  try {
    const financials = await polyFetch<{
      results?: Array<{ filing_date?: string; period_of_report_date?: string }>;
    }>("/vX/reference/financials", {
      ticker,
      timeframe: "quarterly",
      limit: "4",
      sort: "period_of_report_date",
      order: "desc",
    });

    filings = (financials.results ?? [])
      .map((r) => r.filing_date ?? r.period_of_report_date)
      .filter((d): d is string => !!d);
  } catch (err) {
    console.warn(
      `[PolygonEarnings] ${ticker}: financials fetch failed after retries — ${classifyPolygonError(err)}. ` +
      `Earnings date unavailable; Filters 2/5 will bypass this ticker.`,
    );
    return { nextEarningsDate: null, earningsIvHistory: null };
  }

  if (filings.length === 0) {
    console.warn(
      `[PolygonEarnings] ${ticker}: Polygon returned no quarterly filings — earnings date unavailable.`,
    );
  }

  let nextEarningsDate: string | null = null;
  if (filings.length > 0) {
    const next = new Date(filings[0]! + "T00:00:00");
    next.setDate(next.getDate() + 91);
    nextEarningsDate = next.toISOString().split("T")[0]!;
  }

  if (filings.length < 4) {
    return { nextEarningsDate, earningsIvHistory: null };
  }

  // --- Step 2: price aggregates for IV history ---
  try {
    const earliest = filings[filings.length - 1]!;
    const priceFrom = dateOffsetFrom(earliest, -50);
    const priceTo   = dateOffsetFrom(filings[0]!, -1);

    const aggs = await polyFetch<PolygonAggregatesResponse>(
      `/v2/aggs/ticker/${ticker}/range/1/day/${priceFrom}/${priceTo}`,
      { adjusted: "true", sort: "asc", limit: "250" },
    );

    const bars = (aggs.results ?? []).filter((b) => b.t && b.c);
    const records: EarningsIvRecord[] = [];

    for (const earningsDate of filings) {
      const earningsTs = new Date(earningsDate + "T00:00:00").getTime();
      const preCloses: number[]  = [];
      const baseCloses: number[] = [];

      for (const bar of bars) {
        const barDate = new Date(bar.t!).toISOString().split("T")[0]!;
        const daysTo = Math.round(
          (earningsTs - new Date(barDate + "T00:00:00").getTime()) / 86_400_000,
        );
        if (daysTo >= 2  && daysTo <= 7)  preCloses.push(bar.c!);
        if (daysTo >= 15 && daysTo <= 40) baseCloses.push(bar.c!);
      }

      const ivBefore   = realizedVol(preCloses);
      const ivBaseline = realizedVol(baseCloses);
      if (ivBefore === 0 || ivBaseline === 0) continue;

      records.push({
        earningsDate,
        ivBeforeEarnings: parseFloat(ivBefore.toFixed(4)),
        ivBaseline:       parseFloat(ivBaseline.toFixed(4)),
        ivRose:           ivBefore > ivBaseline,
      });
    }

    return {
      nextEarningsDate,
      earningsIvHistory: records.length >= 4 ? records : null,
    };
  } catch (err) {
    console.warn(
      `[PolygonEarnings] ${ticker}: price-aggregates fetch failed after retries — ${classifyPolygonError(err)}. ` +
      `IV history unavailable; earnings date (${nextEarningsDate ?? "null"}) kept.`,
    );
    return { nextEarningsDate, earningsIvHistory: null };
  }
}

// ---------------------------------------------------------------------------
// Per-ticker earnings cache
//
// Earnings dates move on a quarterly cadence, so refetching the whole universe
// every ~5-minute cache refresh is wasteful. Successful lookups (a non-null
// earnings date) are cached for 24h; failures are NOT cached, so the next
// refresh retries them.
// ---------------------------------------------------------------------------

type PolygonEarningsResult = { nextEarningsDate: string | null; earningsIvHistory: EarningsIvRecord[] | null };

const POLYGON_EARNINGS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const polygonEarningsCache = new Map<string, { data: PolygonEarningsResult; fetchedAt: number }>();

/** Test hook: empty the per-ticker earnings cache. */
export function clearPolygonEarningsCache(): void {
  polygonEarningsCache.clear();
}

// ---------------------------------------------------------------------------
// Upcoming corporate events (dividends, splits) — Filter 5's "earnings is the
// only upcoming event" check
// ---------------------------------------------------------------------------

/**
 * Fetches known upcoming corporate events (ex-dividend dates and split
 * execution dates) for a ticker from Polygon.
 *
 * Returns [] when the lookup succeeds and no events are scheduled, or null
 * when the lookup fails (logged with a classified reason). Never throws.
 */
export interface PolygonEventsFetchOptions extends PolygonEarningsFetchOptions {
  /**
   * Awaited before every HTTP request (including retries). Callers with a
   * rate limiter pass its acquire() here so event lookups share the same
   * request budget instead of bypassing it.
   */
  acquireSlot?: () => Promise<void>;
}

export async function fetchPolygonUpcomingEvents(
  apiKey: string,
  ticker: string,
  opts: PolygonEventsFetchOptions = {},
): Promise<UpcomingCorporateEvent[] | null> {
  const baseUrl = "https://api.polygon.io";
  const maxRetries = opts.retries ?? 2;
  const retryBaseMs = opts.retryBaseMs ?? 250;
  const acquireSlot = opts.acquireSlot;

  async function polyFetch<T>(path: string, params: Record<string, string>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (acquireSlot) await acquireSlot();
        const url = new URL(`${baseUrl}${path}`);
        url.searchParams.set("apiKey", apiKey);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        const res = await fetch(url.toString());
        if (!res.ok) {
          const body = await res.text().catch(() => "(no body)");
          throw new PolygonHttpError(`Polygon ${res.status} for ${path}: ${res.statusText} — ${body}`, res.status);
        }
        return (await res.json()) as T;
      } catch (err) {
        if (attempt >= maxRetries || !isRetryablePolygonError(err)) throw err;
        await new Promise((r) => setTimeout(r, retryBaseMs * 2 ** attempt));
      }
    }
  }

  // Local YYYY-MM-DD for "today" (consistent with filter date handling)
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  try {
    const [dividends, splits] = await Promise.all([
      polyFetch<{ results?: Array<{ ex_dividend_date?: string }> }>("/v3/reference/dividends", {
        ticker,
        "ex_dividend_date.gte": today,
        limit: "10",
        sort: "ex_dividend_date",
        order: "asc",
      }),
      polyFetch<{ results?: Array<{ execution_date?: string }> }>("/v3/reference/splits", {
        ticker,
        "execution_date.gte": today,
        limit: "10",
        sort: "execution_date",
        order: "asc",
      }),
    ]);

    const events: UpcomingCorporateEvent[] = [];
    for (const d of dividends.results ?? []) {
      if (d.ex_dividend_date) events.push({ type: "dividend", date: d.ex_dividend_date });
    }
    for (const s of splits.results ?? []) {
      if (s.execution_date) events.push({ type: "split", date: s.execution_date });
    }
    events.sort((a, b) => a.date.localeCompare(b.date));
    return events;
  } catch (err) {
    console.warn(
      `[PolygonEvents] ${ticker}: upcoming-events fetch failed after retries — ${classifyPolygonError(err)}. ` +
      `Filter 5's event check will bypass this ticker.`,
    );
    return null;
  }
}

const polygonEventsCache = new Map<string, { data: UpcomingCorporateEvent[]; fetchedAt: number }>();

/** Test hook: empty the per-ticker upcoming-events cache. */
export function clearPolygonEventsCache(): void {
  polygonEventsCache.clear();
}

/**
 * Cached wrapper around fetchPolygonUpcomingEvents (24h TTL, same policy as
 * the earnings cache: only successful lookups are cached).
 */
export async function fetchPolygonUpcomingEventsCached(
  apiKey: string,
  ticker: string,
  opts: PolygonEventsFetchOptions = {},
): Promise<UpcomingCorporateEvent[] | null> {
  const hit = polygonEventsCache.get(ticker);
  if (hit && Date.now() - hit.fetchedAt < POLYGON_EARNINGS_CACHE_TTL_MS) return hit.data;

  const data = await fetchPolygonUpcomingEvents(apiKey, ticker, opts);
  if (data !== null) polygonEventsCache.set(ticker, { data, fetchedAt: Date.now() });
  return data;
}

/**
 * Cached wrapper around fetchPolygonEarningsData. Returns the cached result
 * for a ticker when it is younger than 24h; otherwise fetches and caches the
 * result only when it actually contains an earnings date.
 */
export async function fetchPolygonEarningsDataCached(
  apiKey: string,
  ticker: string,
  opts: PolygonEarningsFetchOptions = {},
): Promise<PolygonEarningsResult> {
  const hit = polygonEarningsCache.get(ticker);
  if (hit && Date.now() - hit.fetchedAt < POLYGON_EARNINGS_CACHE_TTL_MS) return hit.data;

  const data = await fetchPolygonEarningsData(apiKey, ticker, opts);
  if (data.nextEarningsDate !== null) {
    polygonEarningsCache.set(ticker, { data, fetchedAt: Date.now() });
  }
  return data;
}

// ---------------------------------------------------------------------------
// Confirmed-vs-estimated earnings date resolution
//
// Providers derive an ESTIMATED next earnings date from Polygon filings
// (+91 days). This helper overlays the CONFIRMED date from the Nasdaq
// earnings calendar when one exists, falling back to the estimate otherwise.
// ---------------------------------------------------------------------------

export interface ResolvedEarningsDate {
  nextEarningsDate: string | null;
  earningsDateSource: "confirmed" | "estimated" | null;
}

/**
 * Resolves the earnings date for a symbol: confirmed calendar date first,
 * then the +91-day estimate, then null. Never throws.
 */
export async function resolveEarningsDate(
  symbol: string,
  estimatedDate: string | null,
): Promise<ResolvedEarningsDate> {
  const confirmed = await getConfirmedEarningsDate(symbol);
  if (confirmed) return { nextEarningsDate: confirmed, earningsDateSource: "confirmed" };
  if (estimatedDate) return { nextEarningsDate: estimatedDate, earningsDateSource: "estimated" };
  return { nextEarningsDate: null, earningsDateSource: null };
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
  /**
   * Single /vX/reference/financials fetch that serves both earnings needs:
   *  - nextEarningsDate: derived from the most-recent filing date + 91 days
   *  - earningsIvHistory: realized-vol pattern over the last 4 quarterly cycles
   *
   * Fetching limit:"4" instead of two separate calls (limit:"1" + limit:"4")
   * removes one Polygon API call per ticker — 60+ fewer calls per scan cycle.
   *
   * Returns null for earningsIvHistory when fewer than 4 cycles of usable
   * price data exist.  Returns null for nextEarningsDate on any API error.
   * Degrades gracefully on any failure.
   */
  /**
   * Single /vX/reference/financials fetch that serves both earnings needs:
   *  - nextEarningsDate: derived from the most-recent filing date + 91 days
   *  - earningsIvHistory: realized-vol pattern over the last 4 quarterly cycles
   *
   * Fetching limit:"4" instead of two separate calls (limit:"1" + limit:"4")
   * removes one Polygon API call per ticker — 60+ fewer calls per scan cycle.
   *
   * Fault isolation: the financials call and the subsequent aggregates call
   * have separate error boundaries.  If the aggregates fetch fails (e.g.
   * transient outage) nextEarningsDate is still returned from the already-
   * succeeded financials result; only earningsIvHistory is nulled out.
   *
   * Returns null for earningsIvHistory when fewer than 4 cycles of usable
   * price data exist.  Returns null for nextEarningsDate only when the
   * financials call itself fails.
   */
  private async fetchEarningsData(ticker: string): Promise<{
    nextEarningsDate: string | null;
    earningsIvHistory: EarningsIvRecord[] | null;
  }> {
    // Delegate to the shared module-level helper (rate-limited via this.limiter
    // indirectly: callers already hold a rate-limiter slot from the enclosing
    // fetchStockData call, so no extra throttling is needed here).
    return fetchPolygonEarningsDataCached(this.apiKey, ticker);
  }

  /**
   * Upcoming corporate events (dividends/splits) for Filter 5, routed through
   * this provider's rate limiter so bulk universe scans cannot exceed the
   * configured Polygon request budget. 24h-cached per ticker, so only the
   * first scan of the day pays the extra requests.
   */
  private async fetchUpcomingEvents(ticker: string): Promise<UpcomingCorporateEvent[] | null> {
    return fetchPolygonUpcomingEventsCached(this.apiKey, ticker, {
      acquireSlot: this.limiter ? () => this.limiter!.acquire() : undefined,
    });
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

    // --- Filter 6: Double calendar structure ---
    // Find the longer-term expiry closest to 18 DTE (in the 14–22 DTE range).
    let longerTermExpiry: string | null = null;
    let longerTermDte: number | null = null;
    {
      let minDiff2 = Infinity;
      for (const expiry of expiryDates) {
        const dte = Math.round(
          (new Date(expiry + "T00:00:00").getTime() - todayMs) / 86_400_000
        );
        if (dte < 14 || dte > 22) continue;
        const diff = Math.abs(dte - 18);
        if (diff < minDiff2) { minDiff2 = diff; longerTermExpiry = expiry; longerTermDte = dte; }
      }
    }

    let shortCallStrike: number | null = null;
    let shortPutStrike: number | null = null;
    let callCalendarPeak: number | null = null;
    let putCalendarPeak: number | null = null;

    if (nearTermExpiry && longerTermExpiry) {
      const nearContracts  = byExpiry.get(nearTermExpiry)  ?? [];
      const longerContracts = byExpiry.get(longerTermExpiry) ?? [];

      // Build a strike → {call, put} lookup for the ~18 DTE chain.
      const longByStrike = new Map<number, { call?: PolygonOptionsResult; put?: PolygonOptionsResult }>();
      for (const r of longerContracts) {
        const strike = r.details?.strike_price;
        const type   = r.details?.contract_type;
        if (strike == null || !type) continue;
        if (!longByStrike.has(strike)) longByStrike.set(strike, {});
        const slot = longByStrike.get(strike)!;
        if (type === "call") slot.call = r; else slot.put = r;
      }

      const midOf = (r: PolygonOptionsResult) =>
        ((r.last_quote?.bid ?? 0) + (r.last_quote?.ask ?? 0)) / 2;
      const in30to60 = (r: PolygonOptionsResult) => { const m = midOf(r); return m >= 0.30 && m <= 0.60; };

      // OTM call: highest-strike call priced 30–60¢ (most OTM while still liquid)
      const shortCallR = nearContracts
        .filter(r => r.details?.contract_type === "call" && in30to60(r))
        .sort((a, b) => (b.details?.strike_price ?? 0) - (a.details?.strike_price ?? 0))[0];

      // OTM put: lowest-strike put priced 30–60¢ (most OTM while still liquid)
      const shortPutR = nearContracts
        .filter(r => r.details?.contract_type === "put" && in30to60(r))
        .sort((a, b) => (a.details?.strike_price ?? 0) - (b.details?.strike_price ?? 0))[0];

      if (shortCallR && shortPutR) {
        const cStrike = shortCallR.details!.strike_price!;
        const pStrike = shortPutR.details!.strike_price!;
        const longCallR = longByStrike.get(cStrike)?.call;
        const longPutR  = longByStrike.get(pStrike)?.put;

        if (longCallR && longPutR) {
          const shortCallMid = midOf(shortCallR);
          const shortPutMid  = midOf(shortPutR);
          const longCallMid  = midOf(longCallR);
          const longPutMid   = midOf(longPutR);
          const longCallIv   = safeNum(longCallR.implied_volatility);
          const longPutIv    = safeNum(longPutR.implied_volatility);

          if (longCallMid > 0 && longPutMid > 0 && longCallIv > 0 && longPutIv > 0) {
            shortCallStrike = cStrike;
            shortPutStrike  = pStrike;

            // Calendar ratio spread: 1 short near-term, 2 longs far-term per side.
            // Debit = 2 × long − 1 × short (per side).
            const callDebit   = 2 * longCallMid - shortCallMid;
            const putDebit    = 2 * longPutMid  - shortPutMid;
            const totalDebit  = callDebit + putDebit;

            // Days remaining on the long after the short expires.
            const remainDays = (longerTermDte ?? 18) - (nearTermDte ?? 11);
            const remainT    = Math.max(remainDays, 1) / 365;

            // Peak = 2 × bsAtm(long remaining value) − total debit paid.
            callCalendarPeak = parseFloat(
              (2 * bsAtmValue(cStrike, longCallIv, remainT) - totalDebit).toFixed(2)
            );
            putCalendarPeak = parseFloat(
              (2 * bsAtmValue(pStrike, longPutIv, remainT) - totalDebit).toFixed(2)
            );
          }
        }
      }
    }

    return {
      optionsVolume,
      openInterest,
      impliedVolatility: median(ivValues),
      liquidityMetrics: {
        hasWeeklyOptions, hasPennyIncrements, nearTermSpread, nearTermDte, nearTermIv,
        shortCallStrike, shortPutStrike, callCalendarPeak, putCalendarPeak,
      },
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

          const [optStats, avgVol, earningsData, upcomingEvents] = await Promise.all([
            this.fetchOptionsStats(snap.ticker),
            this.fetchAvgVolume(snap.ticker),
            this.fetchEarningsData(snap.ticker),
            this.fetchUpcomingEvents(snap.ticker),
          ]);
          const { earningsIvHistory } = earningsData;
          const { nextEarningsDate, earningsDateSource } =
            await resolveEarningsDate(snap.ticker, earningsData.nextEarningsDate);

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
            earningsDateSource,
            upcomingEvents,
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
      const [snapData, optStats, avgVol, earningsData, upcomingEvents] = await Promise.all([
        this.polygonFetch<{ ticker?: PolygonTickerSnapshot }>(
          `/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`
        ),
        this.fetchOptionsStats(symbol),
        this.fetchAvgVolume(symbol),
        this.fetchEarningsData(symbol),
        this.fetchUpcomingEvents(symbol),
      ]);
      const { earningsIvHistory } = earningsData;
      const { nextEarningsDate, earningsDateSource } =
        await resolveEarningsDate(symbol, earningsData.nextEarningsDate);

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
        earningsDateSource,
        upcomingEvents,
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

// ===========================================================================
// ThetaData Provider
//
// Uses ThetaData gRPC (mdds-01.thetadata.us:443) for options data and
// Yahoo Finance for stock price / volume / market cap (the account has
// stockSubscription=0, so stock gRPC endpoints return permission errors).
//
// Set MARKET_DATA_PROVIDER=thetadata to activate.
// Set THETADATA_API_KEY to your "td1_..." API key (Replit Secret).
// Optionally set UNIVERSE_CACHE_TTL_SECONDS (default 300).
//
// Limitations compared to the Polygon provider:
//   - nextEarningsDate: always null  (ThetaData has no earnings-date endpoint)
//   - earningsIvHistory: always null (requires historical stock price data)
//   Filters 2 and 4 will therefore not qualify any stock in thetadata mode.
// ===========================================================================

// ---- Small concurrent-call limiter (prevents overwhelming the gRPC server) ----

class ThetaSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  constructor(limit: number) { this.available = limit; }
  acquire(): Promise<void> {
    if (this.available > 0) { this.available--; return Promise.resolve(); }
    return new Promise<void>(res => this.waiters.push(res));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next(); else this.available++;
  }
}

// ---- Protobuf encode helpers ----
// Field numbers come from decoding the ThetaData Python SDK's serialized
// FileDescriptorProto blobs (endpoints_pb2.py and v3grpc/endpoints_pb2.py).

/** Scale factors indexed by the `type` field of ThetaData's Price message. */
const TD_PRICE_FACTORS: readonly number[] = [
  0, 1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1,
  1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9,
];

function pbVarint(n: number): number[] {
  // Encode a non-negative integer as a protobuf varint.
  const out: number[] = [];
  while (n > 127) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n & 0xff);
  return out;
}
function pbTag(f: number, w: number): number[] { return pbVarint((f << 3) | w); }
function pbLen(f: number, data: number[]): number[] {
  return [...pbTag(f, 2), ...pbVarint(data.length), ...data];
}
function pbStr(f: number, s: string): number[] {
  const b = Array.from(new TextEncoder().encode(s));
  return [...pbTag(f, 2), ...pbVarint(b.length), ...b];
}
function pbInt32(f: number, v: number): number[] {
  // Positive int32; pbVarint handles small values correctly.
  return [...pbTag(f, 0), ...pbVarint(v >>> 0)];
}
function pbMapEntry(f: number, key: string, val: string): number[] {
  // Encode one map<string,string> entry as a length-delimited sub-message.
  return pbLen(f, [...pbStr(1, key), ...pbStr(2, val)]);
}

// ---- Protobuf decode helpers ----

/** Read a varint from `data` starting at `pos`; returns [value, newPos]. */
function pbReadVarint(data: Buffer, pos: number): [number, number] {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= data.length) break;
    const b = data[pos++]!;
    result += (b & 0x7f) * mul;
    mul *= 128;
    if (!(b & 0x80)) break;
  }
  return [result, pos];
}

/**
 * Parse a flat protobuf binary message into a field-number → values map.
 * Wire type 0 → number; wire type 2 → Buffer.
 * Repeated fields append to the same array.
 */
function pbReadFields(data: Buffer): Map<number, Array<Buffer | number>> {
  const fields = new Map<number, Array<Buffer | number>>();
  let pos = 0;
  while (pos < data.length) {
    let tag: number;
    try { [tag, pos] = pbReadVarint(data, pos); } catch { break; }
    const fn = tag >> 3;
    const wt = tag & 7;
    if (wt === 0) {
      const [val, np] = pbReadVarint(data, pos); pos = np;
      fields.set(fn, [...(fields.get(fn) ?? []), val]);
    } else if (wt === 2) {
      const [len, np] = pbReadVarint(data, pos); pos = np;
      const slice = data.slice(pos, pos + len); pos += len;
      fields.set(fn, [...(fields.get(fn) ?? []), slice]);
    } else if (wt === 1) {
      const slice = data.slice(pos, pos + 8); pos += 8;
      fields.set(fn, [...(fields.get(fn) ?? []), slice]);
    } else if (wt === 5) {
      const slice = data.slice(pos, pos + 4); pos += 4;
      fields.set(fn, [...(fields.get(fn) ?? []), slice]);
    } else {
      break; // Unknown wire type — stop parsing this message
    }
  }
  return fields;
}

type TdValue = string | number | null;

/**
 * Decode a ThetaData DataValue message.
 * Oneof fields: text(1), number(2), price(3), timestamp(4), null_value(5).
 */
function pbDecodeDataValue(buf: Buffer): TdValue {
  const f = pbReadFields(buf);
  // field 1 = text (string)
  if (f.has(1)) return (f.get(1)![0] as Buffer).toString("utf8");
  // field 2 = number (int64 varint)
  if (f.has(2)) return f.get(2)![0] as number;
  // field 3 = price { value:int32=1, type:int32=2 }
  if (f.has(3)) {
    const pf = pbReadFields(f.get(3)![0] as Buffer);
    const rawVal = (pf.get(1)?.[0] as number) ?? 0;
    const typ    = (pf.get(2)?.[0] as number) ?? 0;
    if (typ === 0) return NaN;
    // Convert unsigned uint32 decoded value → signed int32
    const signedVal = rawVal > 2_147_483_647 ? rawVal - 4_294_967_296 : rawVal;
    return signedVal * (TD_PRICE_FACTORS[typ] ?? 1);
  }
  // field 4 = timestamp { epoch_ms:uint64=1 }
  if (f.has(4)) {
    const tf = pbReadFields(f.get(4)![0] as Buffer);
    return (tf.get(1)?.[0] as number) ?? 0;
  }
  return null;
}

/**
 * Decode a ThetaData DataTable message into an array of row records.
 * DataTable: headers(1 repeated string), data_table(2 repeated DataValueList).
 * DataValueList: values(1 repeated DataValue).
 */
function pbDecodeDataTable(buf: Buffer): Array<Record<string, TdValue>> {
  const f = pbReadFields(buf);
  const headers: string[] = (f.get(1) ?? []).map(h =>
    Buffer.isBuffer(h) ? h.toString("utf8") : String(h)
  );
  const rows: Array<Record<string, TdValue>> = [];
  for (const rowBuf of (f.get(2) ?? []) as Buffer[]) {
    const rowFields = pbReadFields(rowBuf);
    const valueBufs = (rowFields.get(1) ?? []) as Buffer[];
    const record: Record<string, TdValue> = {};
    headers.forEach((h, i) => {
      record[h] = valueBufs[i] ? pbDecodeDataValue(valueBufs[i]!) : null;
    });
    rows.push(record);
  }
  return rows;
}

// ---- ThetaData request encoders ----
// All requests follow the BetaEndpoints schema decoded from the Python SDK.

/**
 * Encode a QueryInfo message (BetaEndpoints.QueryInfo).
 *   auth_token=1  (AuthToken: session_uuid=1)
 *   query_parameters=2  (map<string,string> encoded as repeated sub-message)
 *   email_hint=6
 */
function tdQueryInfo(sessionId: string, email: string): number[] {
  const authToken = pbLen(1, pbStr(1, sessionId));
  const qParam    = pbMapEntry(2, "client", "node");
  const emailHint = pbStr(6, email);
  return [...authToken, ...qParam, ...emailHint];
}

/** Encode OptionListExpirationsRequest. Params: symbol=1 (repeated string). */
function tdEncodeOptionListExpirationsReq(
  sessionId: string, email: string, symbol: string
): Buffer {
  const params = pbStr(1, symbol);          // OptionListExpirationsRequestQuery.symbol
  return Buffer.from([
    ...pbLen(1, tdQueryInfo(sessionId, email)),
    ...pbLen(2, params),
  ]);
}

/**
 * Encode an OptionSnapshotXxxRequest.
 *
 * All three variants (Quote, GreeksAll, OpenInterest) share the same outer
 * shape: query_info=1, params=2.  The params differ only in which field
 * carries `max_dte`:
 *   Quote / OpenInterest : max_dte = field 3
 *   GreeksAll            : max_dte = field 8
 *
 * ContractSpec (Endpoints package): symbol=1, expiration=2, strike=3, right=4.
 * ContractSpec is embedded as params.contract_spec = field 1.
 */
function tdEncodeOptionSnapshotReq(
  rpc: "Quote" | "GreeksAll" | "OpenInterest",
  sessionId: string, email: string,
  symbol: string, expiration: string, maxDte?: number
): Buffer {
  const contractSpec = [
    ...pbStr(1, symbol),
    ...pbStr(2, expiration),
    ...pbStr(3, "*"),
    ...pbStr(4, "both"),
  ];
  const cs = pbLen(1, contractSpec); // params.contract_spec

  let params: number[] = [...cs];
  if (maxDte !== undefined) {
    params = rpc === "GreeksAll"
      ? [...params, ...pbInt32(8, maxDte)]   // GreeksAllRequestQuery.max_dte = 8
      : [...params, ...pbInt32(3, maxDte)];  // Quote/OI RequestQuery.max_dte = 3
  }

  return Buffer.from([
    ...pbLen(1, tdQueryInfo(sessionId, email)),
    ...pbLen(2, params),
  ]);
}

// ---- Yahoo Finance stock quote fetcher ----
// Used because the account has stockSubscription=0 (no stock data from ThetaData).

interface YahooStockData {
  price: number;
  changePercent: number;
  volume: number;
  avgVolume: number;
  marketCap: number;
  name: string;
}

async function fetchYahooStockQuotes(
  symbols: string[]
): Promise<Map<string, YahooStockData>> {
  const result = new Map<string, YahooStockData>();

  // Yahoo Finance v7/quote is blocked; v8/chart works per-symbol.
  // Fetch all in parallel, capped at 15 concurrent requests.
  const CONCURRENCY = 15;

  async function fetchOne(sym: string): Promise<void> {
    try {
      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
        `?interval=1d&range=30d`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return;
      const data = await res.json() as {
        chart?: { result?: Array<{
          meta?: Record<string, unknown>;
          indicators?: { quote?: Array<{ volume?: number[]; close?: number[] }> };
        }> };
      };
      const r = data.chart?.result?.[0];
      if (!r) return;
      const m = r.meta ?? {};
      const price  = Number(m["regularMarketPrice"] ?? 0);
      const volume = Math.round(Number(m["regularMarketVolume"] ?? 0));
      // Compute avgVolume and daily change from historical OHLCV data.
      const closes  = r.indicators?.quote?.[0]?.close?.filter((v): v is number => v != null) ?? [];
      const volumes = r.indicators?.quote?.[0]?.volume?.filter((v): v is number => v != null) ?? [];
      // Daily change = today vs. previous session's close (last two entries in closes array).
      const prevClose = closes.length >= 2 ? closes[closes.length - 2]! : price;
      const changePercent = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
      const avgVolume = volumes.length > 0
        ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length)
        : volume;
      // marketCap not available from this endpoint — display only, not used in filters
      const name = String(m["longName"] ?? m["shortName"] ?? sym);
      result.set(sym, { price, changePercent, volume, avgVolume, marketCap: 0, name });
    } catch {
      // Symbol failed — will appear with zero price
    }
  }

  // Run with concurrency limit
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    await Promise.all(symbols.slice(i, i + CONCURRENCY).map(fetchOne));
  }

  return result;
}

// ---- Helper: extract a number or string from a TdValue row ----

function tdGetNum(row: Record<string, TdValue>, ...keys: string[]): number {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && isFinite(v) && v !== 0) return v;
  }
  return 0;
}

function tdGetStr(row: Record<string, TdValue>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

/**
 * Normalise the options right/side field to a single uppercase letter.
 * ThetaData returns the full word "CALL" or "PUT"; normalise to "C"/"P"
 * so all downstream comparisons are uniform.
 */
function tdNormalizeRight(raw: string): string {
  const u = raw.toUpperCase();
  if (u === "CALL") return "C";
  if (u === "PUT")  return "P";
  return u; // already "C", "P", or something unexpected
}
export class ThetaDataProvider implements IMarketDataProvider {
  readonly providerName = "ThetaDataProvider (ThetaData gRPC + Yahoo Finance + Polygon earnings)";

  private sessionId  = "";
  private email      = "";
  private grpcClient: import("@grpc/grpc-js").Client | null = null;

  private readonly cacheTtlMs: number;
  private universeCache: UniverseCache | null = null;
  private universeRefreshFailed = false;
  private universeRefreshing: Promise<void> | null = null;

  /** Limit concurrent gRPC streaming calls to avoid overwhelming the server. */
  private readonly sem = new ThetaSemaphore(5);

  private initDone  = false;
  private initError: Error | null = null;
  private readonly initPromise: Promise<void>;

  /**
   * Optional Polygon.io API key for fetching earnings dates and IV history.
   * When set, Filters 2, 4, and 5 evaluate fully instead of being bypassed.
   */
  private readonly polygonApiKey: string | null;

  /**
   * Rate limiter shared by all Polygon HTTP requests this provider issues
   * (upcoming-events lookups). Prevents a concurrent universe scan from
   * bursting past the Polygon plan's request budget. Null = unlimited.
   */
  private polygonLimiter: PolygonRateLimiter | null;

  constructor(
    private readonly apiKey: string,
    cacheTtlSeconds = 300,
    polygonApiKey: string | null = null,
    polygonRequestsPerMinute = 100,
  ) {
    this.cacheTtlMs   = cacheTtlSeconds * 1000;
    this.polygonApiKey = polygonApiKey;
    this.polygonLimiter =
      polygonRequestsPerMinute > 0 ? new PolygonRateLimiter(polygonRequestsPerMinute) : null;
    this.initPromise  = this.doInit();
    // Pre-warm universe in the background after auth succeeds.
    this.initPromise
      .then(() => this.refreshUniverseCache())
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Initialisation: authenticate + open gRPC channel
  // -------------------------------------------------------------------------

  private async doInit(): Promise<void> {
    try {
      // 1. Authenticate with ThetaData nexus API
      const res = await fetch(
        "https://nexus-api.thetadata.us/identity/terminal/auth_user",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "TD-TERMINAL-KEY": "cf58ada4-4175-11f0-860f-1e2e95c79e64",
          },
          body: JSON.stringify({
            apiKey: this.apiKey,
            authEnv: { envType: "PROD" },
          }),
          signal: AbortSignal.timeout(15_000),
        }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`ThetaData auth failed (${res.status}): ${text}`);
      }
      const json = await res.json() as {
        sessionId: string;
        user?: { email?: string };
      };
      this.sessionId = json.sessionId;
      this.email     = json.user?.email ?? "";

      // 2. Open a TLS gRPC channel to the market-data server
      const grpc = await import("@grpc/grpc-js");
      this.grpcClient = new grpc.Client(
        "mdds-01.thetadata.us:443",
        grpc.credentials.createSsl()
      );
      this.initDone = true;
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      throw this.initError;
    }
  }

  private async ensureReady(): Promise<void> {
    await this.initPromise;
    if (!this.initDone) {
      throw this.initError ?? new Error("ThetaData provider not initialised");
    }
  }

  // -------------------------------------------------------------------------
  // Low-level gRPC + response decoding
  // -------------------------------------------------------------------------

  /**
   * Make a server-streaming gRPC call and return all ResponseData frames
   * as raw Buffers.  Returns [] on NOT_FOUND (no data for the request).
   * Acquires / releases the semaphore around each call.
   */
  private async callGrpcStream(method: string, reqBuf: Buffer): Promise<Buffer[]> {
    await this.ensureReady();
    await this.sem.acquire();
    try {
      const grpc = await import("@grpc/grpc-js");
      const call = (this.grpcClient as import("@grpc/grpc-js").Client)
        .makeServerStreamRequest(
          method,
          (v: Buffer) => v,  // already serialised
          (v: Buffer) => v,  // keep raw bytes for manual decode
          reqBuf
        );
      return await new Promise<Buffer[]>((resolve, reject) => {
        const chunks: Buffer[] = [];
        call.on("data",  (chunk: Buffer) => chunks.push(chunk));
        call.on("end",   () => resolve(chunks));
        call.on("error", (err: NodeJS.ErrnoException) => {
          // code 5 = NOT_FOUND — treat as empty result, not an error
          if ((err as unknown as Record<string, unknown>)["code"] === 5) resolve([]);
          else reject(err);
        });
      });
    } finally {
      this.sem.release();
    }
  }

  /**
   * Decode a stream of raw ResponseData frames into row records.
   * Each frame may be ZSTD-compressed (algo=1) or uncompressed (algo=0).
   * Decompressed bytes are parsed as a DataTable.
   */
  private async decodeStream(
    chunks: Buffer[]
  ): Promise<Array<Record<string, TdValue>>> {
    if (chunks.length === 0) return [];
    const { decompress } = await import("fzstd");
    const rows: Array<Record<string, TdValue>> = [];

    for (const chunk of chunks) {
      // ResponseData: compressed_data=1, compression_description=2
      const rf = pbReadFields(chunk);
      const compressedData = rf.get(1)?.[0] as Buffer | undefined;
      if (!compressedData || compressedData.length === 0) continue;

      // CompressionDescription: algo=1 (0=NONE, 1=ZSTD)
      const comprBuf = rf.get(2)?.[0] as Buffer | undefined;
      let algo = 0;
      if (comprBuf) {
        const cf = pbReadFields(comprBuf);
        algo = (cf.get(1)?.[0] as number) ?? 0;
      }

      let tableBuffer: Buffer;
      if (algo === 1 /* ZSTD */) {
        const decompressed = decompress(new Uint8Array(compressedData));
        tableBuffer = Buffer.from(decompressed);
      } else {
        tableBuffer = compressedData;
      }
      rows.push(...pbDecodeDataTable(tableBuffer));
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // ThetaData gRPC calls
  // -------------------------------------------------------------------------

  /** Fetch all available expirations for a symbol. */
  private async getOptionExpirations(symbol: string): Promise<string[]> {
    const req    = tdEncodeOptionListExpirationsReq(this.sessionId, this.email, symbol);
    const chunks = await this.callGrpcStream(
      "/BetaEndpoints.BetaThetaTerminal/GetOptionListExpirations",
      req
    );
    const rows = await this.decodeStream(chunks);
    const dates: string[] = [];
    for (const row of rows) {
      // The response typically has one column; try common names first
      const val =
        row["Expiration"] ?? row["expiration"] ??
        Object.values(row).find(v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v as string));
      if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
        dates.push(val);
      }
    }
    return dates.sort();
  }

  /**
   * Fetch an options snapshot (Quote, GreeksAll, or OpenInterest).
   * Pass `expiration="*"` to get all expirations; use `maxDte` to limit.
   */
  private async getOptionSnapshot(
    rpc: "Quote" | "GreeksAll" | "OpenInterest",
    symbol: string,
    expiration: string,
    maxDte?: number
  ): Promise<Array<Record<string, TdValue>>> {
    const grpcMethod: Record<string, string> = {
      Quote:        "/BetaEndpoints.BetaThetaTerminal/GetOptionSnapshotQuote",
      GreeksAll:    "/BetaEndpoints.BetaThetaTerminal/GetOptionSnapshotGreeksAll",
      OpenInterest: "/BetaEndpoints.BetaThetaTerminal/GetOptionSnapshotOpenInterest",
    };
    const req    = tdEncodeOptionSnapshotReq(rpc, this.sessionId, this.email, symbol, expiration, maxDte);
    const chunks = await this.callGrpcStream(grpcMethod[rpc]!, req);
    return this.decodeStream(chunks);
  }

  // -------------------------------------------------------------------------
  // Liquidity-metrics computation (same algorithm as LiveMarketDataProvider)
  // -------------------------------------------------------------------------

  private buildLiquidityMetrics(
    quoteRows : Array<Record<string, TdValue>>,
    greekRows : Array<Record<string, TdValue>>,
    todayMs   : number
  ): {
    optionsVolume    : number;
    openInterest     : number;
    impliedVolatility: number;
    liquidityMetrics : OptionsLiquidityMetrics;
  } | null {
    if (quoteRows.length === 0) return null;

    // ---- Collect unique expirations from quote rows ----
    const dteFn = (exp: string) => {
      const ms = new Date(exp + "T00:00:00Z").getTime() - todayMs;
      return Math.round(ms / 86_400_000);
    };

    const expSet = new Set<string>();
    for (const row of quoteRows) {
      const e = tdGetStr(row, "Expiration", "expiration");
      if (/^\d{4}-\d{2}-\d{2}$/.test(e) && dteFn(e) >= 0) expSet.add(e);
    }
    const expirations = [...expSet].sort();
    if (expirations.length === 0) return null;

    const sortedExps = expirations.filter(e => dteFn(e) >= 3);
    const nearExp    = sortedExps.find(e => dteFn(e) >= 7) ?? sortedExps[0];
    const longExp    = sortedExps.find(e => dteFn(e) >= 14 && e !== nearExp)
                       ?? sortedExps.find(e => e !== nearExp);
    if (!nearExp) return null;

    const nearDte = dteFn(nearExp);

    // ---- Build quote map for near-term expiration ----
    interface QSlot { bid: number; ask: number; bidSz: number; askSz: number }
    const quoteMap = new Map<string, QSlot>();
    let totalVol = 0;
    let totalOI  = 0;

    for (const row of quoteRows) {
      const exp    = tdGetStr(row, "Expiration", "expiration");
      if (exp !== nearExp) continue;
      const strike = tdGetNum(row, "Strike", "strike");
      const right  = tdNormalizeRight(tdGetStr(row, "Right", "right", "CallPut", "call_put"));
      if (!strike || (right !== "C" && right !== "P")) continue;

      const key  = `${strike}:${right}`;
      const bid  = tdGetNum(row, "Bid",     "bid",      "BidPrice", "bid_price");
      const ask  = tdGetNum(row, "Ask",     "ask",      "AskPrice", "ask_price");
      const bidSz = tdGetNum(row, "BidSize", "bid_size", "BidSz");
      const askSz = tdGetNum(row, "AskSize", "ask_size", "AskSz");

      quoteMap.set(key, { bid, ask, bidSz, askSz });
      totalVol += bidSz;
      totalOI  += bidSz + askSz;
    }

    // ---- Build greek map for near-term and long-term expirations ----
    interface GSlot { iv: number }
    const greekMapNear = new Map<string, GSlot>();
    const greekMapLong = new Map<string, GSlot>();

    for (const row of greekRows) {
      const exp    = tdGetStr(row, "Expiration", "expiration");
      const strike = tdGetNum(row, "Strike", "strike");
      const right  = tdNormalizeRight(tdGetStr(row, "Right", "right", "CallPut", "call_put"));
      if (!strike || (right !== "C" && right !== "P")) continue;
      const key = `${strike}:${right}`;
      // ThetaData GreeksAll uses the column name "implied_vol" (confirmed against live traffic).
      // Keep the broader alias list for any other provider that might use a different name.
      const iv  = tdGetNum(row, "implied_vol", "MidIV", "mid_iv", "IV", "iv", "ImpliedVolatility", "implied_volatility");
      if (iv <= 0) continue;

      if (exp === nearExp) greekMapNear.set(key, { iv });
      if (longExp && exp === longExp) greekMapLong.set(key, { iv });
    }

    // ---- Aggregate implied volatility ----
    const ivValues: number[] = [];
    for (const [, g] of greekMapNear) if (g.iv > 0) ivValues.push(g.iv);
    const aggIv = ivValues.length > 0 ? median(ivValues) : 0;

    // ---- hasWeeklyOptions ----
    const hasWeeklyOptions = expirations.some(e => !isThirdFriday(e));

    // ---- Near-term spread + penny increments + nearTermIv ----
    let hasPennyIncrements = false;
    const spreads: number[] = [];
    const nearIvValues: number[] = [];

    for (const [key, q] of quoteMap) {
      const mid = (q.bid + q.ask) / 2;
      if (mid >= 0.2 && mid <= 0.7) {
        if (isPennyIncrement(q.bid) || isPennyIncrement(q.ask)) hasPennyIncrements = true;
        spreads.push(q.ask - q.bid);
      }
      const g = greekMapNear.get(key);
      if (g && g.iv > 0) nearIvValues.push(g.iv);
    }

    const nearTermSpread: number | null =
      spreads.length > 0
        ? parseFloat((spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(4))
        : null;
    const nearTermIv: number | null =
      nearIvValues.length > 0 ? parseFloat(median(nearIvValues).toFixed(4)) : null;

    // ---- Calendar spread: find short call/put + compute peaks ----
    let shortCallStrike : number | null = null;
    let shortPutStrike  : number | null = null;
    let callCalendarPeak: number | null = null;
    let putCalendarPeak : number | null = null;

    const in30to60 = (q: QSlot) => { const m = (q.bid + q.ask) / 2; return m >= 0.30 && m <= 0.60; };
    const callCands: Array<{ strike: number; q: QSlot }> = [];
    const putCands : Array<{ strike: number; q: QSlot }> = [];

    for (const [key, q] of quoteMap) {
      if (!in30to60(q)) continue;
      const [strikeStr, right] = key.split(":");
      const strike = Number(strikeStr);
      if (right === "C") callCands.push({ strike, q });
      if (right === "P") putCands.push({ strike, q });
    }
    callCands.sort((a, b) => b.strike - a.strike); // highest OTM call first
    putCands.sort( (a, b) => a.strike - b.strike); // lowest  OTM put  first

    const bestCall = callCands[0];
    const bestPut  = putCands[0];

    if (bestCall && bestPut && longExp) {
      const longCallG = greekMapLong.get(`${bestCall.strike}:C`);
      const longPutG  = greekMapLong.get(`${bestPut.strike}:P`);

      // We need mid prices for both the near-term short legs (from quoteMap)
      // and the longer-term long legs. For the long legs we fetch their
      // quote prices from greekRows if available, otherwise estimate via B-S.
      if (longCallG && longPutG && longCallG.iv > 0 && longPutG.iv > 0) {
        shortCallStrike = bestCall.strike;
        shortPutStrike  = bestPut.strike;

        const shortCallMid = (bestCall.q.bid + bestCall.q.ask) / 2;
        const shortPutMid  = (bestPut.q.bid  + bestPut.q.ask)  / 2;

        // Find long-leg quote prices from the full greekRows set (which covers wider DTE)
        const longCallRow = greekRows.find(r => {
          const exp = tdGetStr(r, "Expiration", "expiration");
          const st  = tdGetNum(r, "Strike", "strike");
          const rt  = tdNormalizeRight(tdGetStr(r, "Right", "right", "CallPut", "call_put"));
          return exp === longExp && st === bestCall.strike && rt === "C";
        });
        const longPutRow = greekRows.find(r => {
          const exp = tdGetStr(r, "Expiration", "expiration");
          const st  = tdGetNum(r, "Strike", "strike");
          const rt  = tdNormalizeRight(tdGetStr(r, "Right", "right", "CallPut", "call_put"));
          return exp === longExp && st === bestPut.strike && rt === "P";
        });

        const longDte    = dteFn(longExp);
        const remainDays = Math.max(longDte - nearDte, 1);
        const remainT    = remainDays / 365;

        // Use ATM B-S approximation for long-leg midpoint if no quote data
        const longCallMid = longCallRow
          ? tdGetNum(longCallRow, "Bid", "bid") > 0 || tdGetNum(longCallRow, "Ask", "ask") > 0
              ? (tdGetNum(longCallRow, "Bid", "bid") + tdGetNum(longCallRow, "Ask", "ask")) / 2
              : bsAtmValue(bestCall.strike, longCallG.iv, remainT)
          : bsAtmValue(bestCall.strike, longCallG.iv, remainT);
        const longPutMid = longPutRow
          ? tdGetNum(longPutRow, "Bid", "bid") > 0 || tdGetNum(longPutRow, "Ask", "ask") > 0
              ? (tdGetNum(longPutRow, "Bid", "bid") + tdGetNum(longPutRow, "Ask", "ask")) / 2
              : bsAtmValue(bestPut.strike, longPutG.iv, remainT)
          : bsAtmValue(bestPut.strike, longPutG.iv, remainT);

        // Calendar ratio spread: 1 short near-term, 2 longs far-term per side.
        // Debit = 2 × long − 1 × short (per side).
        const callDebit  = 2 * longCallMid - shortCallMid;
        const putDebit   = 2 * longPutMid  - shortPutMid;
        const totalDebit = callDebit + putDebit;

        // Peak = 2 × bsAtm(long remaining value) − total debit paid.
        callCalendarPeak = parseFloat((2 * bsAtmValue(bestCall.strike, longCallG.iv, remainT) - totalDebit).toFixed(2));
        putCalendarPeak  = parseFloat((2 * bsAtmValue(bestPut.strike,  longPutG.iv,  remainT) - totalDebit).toFixed(2));
      }
    }

    return {
      optionsVolume:     totalVol,
      openInterest:      totalOI,
      impliedVolatility: parseFloat(aggIv.toFixed(4)),
      liquidityMetrics: {
        hasWeeklyOptions,
        hasPennyIncrements,
        nearTermSpread,
        nearTermDte: nearDte,
        nearTermIv,
        shortCallStrike,
        shortPutStrike,
        callCalendarPeak,
        putCalendarPeak,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Per-ticker enrichment
  // -------------------------------------------------------------------------

  private async enrichTicker(
    symbol   : string,
    yahooData: Map<string, YahooStockData>,
    todayMs  : number
  ): Promise<StockQuote | null> {
    try {
      const yq = yahooData.get(symbol);

      // Fetch quote data (≤20 DTE) and greek data (≤35 DTE) in parallel.
      // Using expiration="*" with max_dte lets ThetaData return all expirations
      // in one shot, eliminating the separate GetOptionListExpirations call.
      const [quoteRows, greekRows] = await Promise.all([
        this.getOptionSnapshot("Quote",     symbol, "*", 20),
        this.getOptionSnapshot("GreeksAll", symbol, "*", 35),
      ]);

      if (quoteRows.length === 0 && greekRows.length === 0) return null;

      const metrics = this.buildLiquidityMetrics(quoteRows, greekRows, todayMs);

      // If Yahoo Finance failed (price = 0), fall back to the underlying price
      // embedded in the GreeksAll snapshot rows. This prevents maxSpreadForPrice()
      // from using the wrong (<$100) spread-limit tier and misclassifying stocks.
      const yahooPrice = yq?.price ?? 0;
      const underlyingPrice = yahooPrice > 0
        ? yahooPrice
        : (() => {
            for (const row of greekRows) {
              const p = tdGetNum(row, "underlying_price");
              if (p > 0) return p;
            }
            return 0;
          })();

      // Supplement ThetaData options data with Polygon earnings data when available.
      // This eliminates the bypass on Filters 2, 4, and 5.
      const earningsData = this.polygonApiKey
        ? await fetchPolygonEarningsDataCached(this.polygonApiKey, symbol).catch((err: unknown) => {
            // fetchPolygonEarningsData never throws, so this only fires on
            // unexpected faults (e.g. cache layer bugs). Log — never silent.
            console.warn(
              `[ThetaDataProvider] ${symbol}: unexpected earnings-data failure — ` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
            return {
              nextEarningsDate: null as string | null,
              earningsIvHistory: null as EarningsIvRecord[] | null,
            };
          })
        : { nextEarningsDate: null as string | null, earningsIvHistory: null as EarningsIvRecord[] | null };

      const upcomingEvents = this.polygonApiKey
        ? await fetchPolygonUpcomingEventsCached(this.polygonApiKey, symbol, {
            acquireSlot: this.polygonLimiter ? () => this.polygonLimiter!.acquire() : undefined,
          }).catch((err: unknown) => {
            console.warn(
              `[ThetaDataProvider] ${symbol}: unexpected upcoming-events failure — ` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
            return null;
          })
        : null;

      // Overlay confirmed calendar date on the Polygon estimate. Runs even
      // without a Polygon key — ThetaData mode gains confirmed dates too.
      const resolvedEarnings = await resolveEarningsDate(symbol, earningsData.nextEarningsDate);

      return {
        symbol,
        company:             TICKER_NAMES[symbol] ?? symbol,
        price:               parseFloat(underlyingPrice.toFixed(2)),
        dailyChangePercent:  parseFloat((yq?.changePercent ?? 0).toFixed(2)),
        volume:              yq?.volume   ?? 0,
        avgVolume:           yq?.avgVolume ?? 0,
        marketCap:           yq?.marketCap ?? 0,
        impliedVolatility:   metrics?.impliedVolatility ?? 0,
        optionsVolume:       metrics?.optionsVolume     ?? 0,
        openInterest:        metrics?.openInterest      ?? 0,
        sector:              TICKER_SECTORS[symbol] ?? "other",
        nextEarningsDate:    resolvedEarnings.nextEarningsDate,
        earningsDateSource:  resolvedEarnings.earningsDateSource,
        upcomingEvents,
        liquidityMetrics:    metrics?.liquidityMetrics ?? null,
        earningsIvHistory:   earningsData.earningsIvHistory,
      };
    } catch {
      // Drop this ticker on error rather than zero-filling
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Universe cache (stale-while-revalidate, same pattern as Polygon provider)
  // -------------------------------------------------------------------------

  private async fetchUniverseFromThetaData(): Promise<StockQuote[]> {
    const todayMs = Date.now();

    // Batch-fetch all stock quotes from Yahoo Finance in one HTTP call
    const yahooData = await fetchYahooStockQuotes(LIVE_STOCK_UNIVERSE);

    // Enrich each ticker concurrently (semaphore limits gRPC concurrency)
    const results = await Promise.all(
      LIVE_STOCK_UNIVERSE.map(sym => this.enrichTicker(sym, yahooData, todayMs))
    );

    return results.filter((q): q is StockQuote => q !== null);
  }

  private refreshUniverseCache(): Promise<void> {
    if (this.universeRefreshing) return this.universeRefreshing;

    this.universeRefreshing = this.fetchUniverseFromThetaData()
      .then((data) => {
        // Guard: after the market closes, ThetaData's option snapshots return
        // no rows, so every ticker is dropped and the refresh "succeeds" with
        // an empty (or drastically shrunken) list. Never let that wipe out a
        // previously good universe — keep serving the last market session's
        // data and mark freshness as cached.
        const prior = this.universeCache;
        if (prior && prior.data.length > 0 && data.length < prior.data.length * 0.5) {
          console.warn(
            `[ThetaDataProvider] Universe refresh returned ${data.length} stocks ` +
            `(previously ${prior.data.length}) — likely no post-close snapshot data. ` +
            `Keeping cached universe from ${new Date(prior.fetchedAt).toISOString()}.`,
          );
          this.universeRefreshFailed = true; // → dataFreshness.source = "cached"
          return;
        }
        this.universeCache        = { data, fetchedAt: Date.now() };
        this.universeRefreshFailed = false;
      })
      .catch((err: unknown) => {
        this.universeRefreshFailed = true;
        if (!this.universeCache) throw err; // cold-start failure → propagate
      })
      .finally(() => { this.universeRefreshing = null; });

    return this.universeRefreshing;
  }

  // -------------------------------------------------------------------------
  // IMarketDataProvider implementation
  // -------------------------------------------------------------------------

  async getStockUniverse(): Promise<StockUniverseResult> {
    const now     = Date.now();
    const isStale = !this.universeCache || now - this.universeCache.fetchedAt > this.cacheTtlMs;

    if (!this.universeCache) {
      await this.refreshUniverseCache(); // cold start — must wait
    } else if (isStale) {
      this.refreshUniverseCache().catch(() => {}); // serve stale; refresh async
    }

    if (!this.universeCache) {
      throw new Error("ThetaData universe fetch failed and no cached data is available");
    }

    return {
      stocks: this.universeCache.data,
      dataFreshness: {
        timestamp: new Date(this.universeCache.fetchedAt).toISOString(),
        source: this.universeRefreshFailed ? "cached" : "live",
      },
    };
  }

  async getStockQuote(symbol: string): Promise<StockQuote | null> {
    const yahooData = await fetchYahooStockQuotes([symbol]);
    return this.enrichTicker(symbol, yahooData, Date.now());
  }

  async getOptionsChain(symbol: string): Promise<OptionsChain | null> {
    try {
      const expirations = await this.getOptionExpirations(symbol);
      if (expirations.length === 0) return null;

      // Fetch quote rows for the first 4 expirations
      const relevantExps = expirations.slice(0, 4);
      const contractMap  = new Map<
        string,
        { call?: Record<string, TdValue>; put?: Record<string, TdValue> }
      >();

      for (const exp of relevantExps) {
        const rows = await this.getOptionSnapshot("Quote", symbol, exp);
        for (const row of rows) {
          const strike = tdGetNum(row, "Strike", "strike");
          const right  = tdNormalizeRight(tdGetStr(row, "Right", "right", "CallPut", "call_put"));
          if (!strike || (right !== "C" && right !== "P")) continue;
          const key   = `${exp}:${strike}`;
          const entry = contractMap.get(key) ?? {};
          if (right === "C") entry.call = row; else entry.put = row;
          contractMap.set(key, entry);
        }
      }

      const expSet:    Set<string>         = new Set();
      const contracts: OptionsContract[]   = [];

      for (const [key, sides] of contractMap) {
        const colonIdx = key.indexOf(":");
        const exp      = key.slice(0, colonIdx);
        const strike   = parseFloat(key.slice(colonIdx + 1));
        if (!exp || !strike) continue;
        expSet.add(exp);

        const call = sides.call ?? {};
        const put  = sides.put  ?? {};
        contracts.push({
          strike,
          expiration: exp,
          callBid:   tdGetNum(call, "Bid", "bid"),
          callAsk:   tdGetNum(call, "Ask", "ask"),
          callVolume: 0, callOI: 0,
          callIV:    tdGetNum(call, "MidIV", "mid_iv", "IV", "iv"),
          callDelta: 0, callGamma: 0, callTheta: 0, callVega: 0,
          putBid:    tdGetNum(put,  "Bid", "bid"),
          putAsk:    tdGetNum(put,  "Ask", "ask"),
          putVolume: 0, putOI: 0,
          putIV:     tdGetNum(put,  "MidIV", "mid_iv", "IV", "iv"),
          putDelta: 0, putGamma: 0, putTheta: 0, putVega: 0,
        });
      }

      contracts.sort((a, b) => {
        const cmp = a.expiration.localeCompare(b.expiration);
        return cmp !== 0 ? cmp : a.strike - b.strike;
      });

      return { symbol, expirations: [...expSet].sort(), contracts };
    } catch {
      return null;
    }
  }

  async getMarketStatus(): Promise<MarketStatusData> {
    // ThetaData has no market-status endpoint; derive from wall-clock ET.
    const now  = new Date();
    const etMs = now.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
    const [hStr, mStr] = etMs.split(":");
    const etTotal = parseInt(hStr ?? "0") * 60 + parseInt(mStr ?? "0");
    const etDate  = new Date(now.toLocaleDateString("en-US", { timeZone: "America/New_York" }));
    const dow     = etDate.getDay(); // 0=Sun, 6=Sat

    let state: MarketStatusData["state"];
    let label: string;
    let description: string;

    if (dow === 0 || dow === 6) {
      state = "closed"; label = "CLOSED"; description = "Market closed (weekend)";
    } else if (etTotal >= 9 * 60 + 30 && etTotal < 16 * 60) {
      state = "open";       label = "OPEN";       description = "Regular trading session (9:30 AM – 4:00 PM ET)";
    } else if (etTotal >= 4 * 60 && etTotal < 9 * 60 + 30) {
      state = "pre_market"; label = "PRE-MARKET"; description = "Pre-market trading (4:00 AM – 9:30 AM ET)";
    } else if (etTotal >= 16 * 60 && etTotal < 20 * 60) {
      state = "after_hours"; label = "AFTER-HOURS"; description = "After-hours trading (4:00 PM – 8:00 PM ET)";
    } else {
      state = "closed"; label = "CLOSED"; description = "Market closed";
    }

    return { state, label, description, timestamp: now, nextOpen: null, nextClose: null };
  }
}

// ---------------------------------------------------------------------------
// Factory — reads env vars and returns the correct provider
// ---------------------------------------------------------------------------

export function createMarketDataProvider(): IMarketDataProvider {
  const mode = process.env.MARKET_DATA_PROVIDER ?? "mock";

  if (mode === "thetadata") {
    const apiKey = process.env.THETADATA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "MARKET_DATA_PROVIDER=thetadata but THETADATA_API_KEY is not set. " +
          "Add your ThetaData API key to Replit Secrets."
      );
    }
    const cacheTtl     = parseInt(process.env.UNIVERSE_CACHE_TTL_SECONDS ?? "300", 10);
    const polygonApiKey = process.env.MARKET_DATA_API_KEY ?? null;
    if (!polygonApiKey) {
      console.warn(
        "[ThetaDataProvider] MARKET_DATA_API_KEY not set — earnings data unavailable. " +
        "Filters 2, 4, and 5 will be bypassed. Set MARKET_DATA_API_KEY to a Polygon.io key to enable them."
      );
    }
    // Same knob as live mode: POLYGON_REQUESTS_PER_MINUTE (default 100,
    // appropriate for Polygon Starter; 0 = unlimited).
    const thetaPolygonRpm = parseInt(process.env.POLYGON_REQUESTS_PER_MINUTE ?? "100", 10);
    return new ThetaDataProvider(
      apiKey,
      isFinite(cacheTtl) && cacheTtl > 0 ? cacheTtl : 300,
      polygonApiKey,
      isFinite(thetaPolygonRpm) && thetaPolygonRpm >= 0 ? thetaPolygonRpm : 100,
    );
  }

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
