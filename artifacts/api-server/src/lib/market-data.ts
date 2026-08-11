/**
 * Market Data Provider
 *
 * Defines the IMarketDataProvider interface and the MockMarketDataProvider.
 * When a live data provider is available, implement IMarketDataProvider and
 * swap it in by setting MARKET_DATA_PROVIDER=live.
 *
 * To connect a live provider:
 *  1. Implement LiveMarketDataProvider (IMarketDataProvider)
 *  2. Set MARKET_DATA_PROVIDER=live and MARKET_DATA_API_KEY in environment
 *  3. Replace the singleton export at the bottom of this file
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

export interface IMarketDataProvider {
  /** Returns all stocks available for screening */
  getStockUniverse(): Promise<StockQuote[]>;
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
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 6=Sat

  // Market hours: 9:30–16:00 ET = 14:30–21:00 UTC (rough approximation)
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

// MOCK IMPLEMENTATION — replace with LiveMarketDataProvider when ready
export class MockMarketDataProvider implements IMarketDataProvider {
  readonly providerName = "MockMarketDataProvider";

  async getStockUniverse(): Promise<StockQuote[]> {
    // Simulate slight price fluctuations on each fetch
    return MOCK_STOCKS.map((s) => ({
      ...s,
      price: parseFloat((s.price * (1 + (Math.random() - 0.5) * 0.002)).toFixed(2)),
      dailyChangePercent: parseFloat((s.dailyChangePercent + (Math.random() - 0.5) * 0.1).toFixed(2)),
    }));
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

// STUB — replace body with LiveMarketDataProvider when credentials are available
// export class LiveMarketDataProvider implements IMarketDataProvider {
//   constructor(private apiKey: string) {}
//   readonly providerName = "LiveMarketDataProvider";
//   async getStockUniverse() { /* call real API */ }
//   async getStockQuote(symbol) { /* call real API */ }
//   async getOptionsChain(symbol) { /* call real API */ }
//   async getMarketStatus() { /* call real API */ }
// }

export const marketDataProvider: IMarketDataProvider = new MockMarketDataProvider();
