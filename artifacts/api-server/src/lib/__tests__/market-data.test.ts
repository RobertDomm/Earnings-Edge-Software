/**
 * market-data.test.ts
 *
 * Tests for MockMarketDataProvider and the LiveMarketDataProvider universe
 * cache.  Run with:
 *
 *   pnpm --filter @workspace/api-server run test
 *
 * Uses Node.js built-in test runner (node:test) and a globalThis.fetch mock
 * so no network access is required.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  MockMarketDataProvider,
  LiveMarketDataProvider,
  LIVE_STOCK_UNIVERSE,
} from "../market-data.js";

// ---------------------------------------------------------------------------
// Polygon API mock helpers
// ---------------------------------------------------------------------------

/**
 * Builds mock snapshot tickers for every symbol in LIVE_STOCK_UNIVERSE so that
 * tests exercise the full configured universe cardinality.
 */
const FULL_MOCK_TICKERS = LIVE_STOCK_UNIVERSE.map((ticker) => ({
  ticker,
  lastTrade: { p: 150 + Math.floor(Math.random() * 500) },
  todaysChangePerc: (Math.random() - 0.5) * 4,
  day: { v: 20_000_000 + Math.floor(Math.random() * 80_000_000), c: 150 },
  prevDay: { v: 18_000_000, c: 148 },
}));

function makeJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Returns a fetch mock that:
 * - serves all 69 universe tickers on the batch snapshot endpoint,
 * - serves one call+put contract on every options endpoint,
 * - serves 30 daily bars on every aggregates endpoint,
 * - serves an "open" market status.
 *
 * An optional `onRequest` callback is called for every fetch so tests can
 * count calls or inspect URLs.
 */
function buildMockFetch(onRequest?: (url: string) => void): typeof fetch {
  return async (input: string | URL | Request): Promise<Response> => {
    const url =
      input instanceof Request ? input.url : input.toString();

    onRequest?.(url);

    // Batch stock snapshot — returns all tickers in the configured universe
    if (url.includes("/v2/snapshot/locale/us/markets/stocks/tickers?")) {
      return makeJsonResponse({ tickers: FULL_MOCK_TICKERS, status: "OK" });
    }

    // Single stock snapshot
    if (/\/v2\/snapshot\/locale\/us\/markets\/stocks\/tickers\/[A-Z]+$/.test(url)) {
      return makeJsonResponse({ ticker: FULL_MOCK_TICKERS[0], status: "OK" });
    }

    // Options snapshot — one call + one put contract per ticker
    if (url.includes("/v3/snapshot/options/")) {
      return makeJsonResponse({
        results: [
          {
            implied_volatility: 0.30,
            open_interest: 1_200_000,
            day: { volume: 600_000 },
            details: {
              contract_type: "call",
              strike_price: 150,
              expiration_date: "2026-10-17",
            },
            last_quote: { bid: 5.0, ask: 5.1 },
            greeks: { delta: 0.55, gamma: 0.02, theta: -0.08, vega: 0.15 },
          },
          {
            implied_volatility: 0.32,
            open_interest: 980_000,
            day: { volume: 420_000 },
            details: {
              contract_type: "put",
              strike_price: 150,
              expiration_date: "2026-10-17",
            },
            last_quote: { bid: 4.8, ask: 4.9 },
            greeks: { delta: -0.45, gamma: 0.02, theta: -0.07, vega: 0.14 },
          },
        ],
        status: "OK",
      });
    }

    // Daily aggregates (30-day avg volume)
    if (url.includes("/v2/aggs/ticker/")) {
      return makeJsonResponse({
        results: Array.from({ length: 30 }, (_, i) => ({
          v: 50_000_000 + i * 100_000,
          c: 150 + i * 0.1,
          t: Date.now() - (30 - i) * 86_400_000,
        })),
        status: "OK",
      });
    }

    // Market status
    if (url.includes("/v1/marketstatus/now")) {
      return makeJsonResponse({
        market: "open",
        afterHours: false,
        earlyHours: false,
      });
    }

    return makeJsonResponse({ status: "OK" });
  };
}

// ---------------------------------------------------------------------------
// MockMarketDataProvider tests
// ---------------------------------------------------------------------------

describe("MockMarketDataProvider", () => {
  it("getStockUniverse returns stocks with all screening fields populated", async () => {
    const provider = new MockMarketDataProvider();
    const stocks = await provider.getStockUniverse();

    assert.ok(stocks.length > 0, "should return at least one stock");

    for (const stock of stocks) {
      assert.ok(
        stock.impliedVolatility > 0,
        `${stock.symbol}: impliedVolatility must be > 0 (got ${stock.impliedVolatility})`
      );
      assert.ok(
        stock.optionsVolume > 0,
        `${stock.symbol}: optionsVolume must be > 0 (got ${stock.optionsVolume})`
      );
      assert.ok(
        stock.openInterest > 0,
        `${stock.symbol}: openInterest must be > 0 (got ${stock.openInterest})`
      );
      assert.ok(
        stock.avgVolume > 0,
        `${stock.symbol}: avgVolume must be > 0 (got ${stock.avgVolume})`
      );
    }
  });

  it("getStockQuote returns the requested symbol with populated fields", async () => {
    const provider = new MockMarketDataProvider();
    const quote = await provider.getStockQuote("AAPL");

    assert.ok(quote !== null, "should return a quote for AAPL");
    assert.equal(quote.symbol, "AAPL");
    assert.ok(quote.price > 0, "price must be > 0");
    assert.ok(quote.impliedVolatility > 0, "impliedVolatility must be > 0");
  });

  it("getStockQuote returns null for unknown symbol", async () => {
    const provider = new MockMarketDataProvider();
    const quote = await provider.getStockQuote("ZZZNOTREAL");
    assert.equal(quote, null);
  });

  it("getOptionsChain returns contracts for a known symbol", async () => {
    const provider = new MockMarketDataProvider();
    const chain = await provider.getOptionsChain("AAPL");

    assert.ok(chain !== null, "should return an options chain for AAPL");
    assert.ok(chain.contracts.length > 0, "chain should have contracts");
    assert.ok(chain.expirations.length > 0, "chain should have expirations");

    for (const c of chain.contracts) {
      assert.ok(c.callIV > 0, "callIV must be > 0");
      assert.ok(c.putIV > 0, "putIV must be > 0");
    }
  });

  it("getMarketStatus returns a valid state", async () => {
    const provider = new MockMarketDataProvider();
    const status = await provider.getMarketStatus();
    const validStates = ["open", "closed", "pre_market", "after_hours"];

    assert.ok(
      validStates.includes(status.state),
      `state must be one of ${validStates.join(", ")} (got ${status.state})`
    );
  });
});

// ---------------------------------------------------------------------------
// LiveMarketDataProvider — universe cache + singleton tests
// ---------------------------------------------------------------------------

describe("LiveMarketDataProvider universe cache", () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    // Each test installs its own fetch mock
    globalThis.fetch = buildMockFetch();
  });

  it(
    "getStockUniverse enriches all universe tickers with correct Polygon field mappings",
    async () => {
      // 10 000 RPM = 6 ms between requests — finite rate limiter, fast enough for tests
      const provider = new LiveMarketDataProvider("test-api-key", 10_000, 60);
      const stocks = await provider.getStockUniverse();

      // All symbols in LIVE_STOCK_UNIVERSE should be enriched (mock returns data for all)
      assert.ok(
        stocks.length === LIVE_STOCK_UNIVERSE.length,
        `expected ${LIVE_STOCK_UNIVERSE.length} stocks, got ${stocks.length}`
      );

      for (const stock of stocks) {
        assert.ok(
          stock.impliedVolatility > 0,
          `${stock.symbol}: IV must come from top-level implied_volatility (got ${stock.impliedVolatility})`
        );
        assert.ok(
          stock.optionsVolume > 0,
          `${stock.symbol}: optionsVolume must be > 0`
        );
        assert.ok(
          stock.openInterest > 0,
          `${stock.symbol}: openInterest must come from top-level open_interest (got ${stock.openInterest})`
        );
        assert.ok(
          stock.avgVolume > 0,
          `${stock.symbol}: avgVolume from 30-day aggregates must be > 0`
        );
      }
    }
  );

  it("construction triggers exactly one batch snapshot request (single pre-warm)", async () => {
    let batchSnapshotCalls = 0;
    globalThis.fetch = buildMockFetch((url) => {
      if (url.includes("/v2/snapshot/locale/us/markets/stocks/tickers?")) {
        batchSnapshotCalls++;
      }
    });

    const provider = new LiveMarketDataProvider("test-api-key", 10_000, 300);

    // Await the first populate so the counter is stable
    await provider.getStockUniverse();

    assert.equal(
      batchSnapshotCalls,
      1,
      `batch snapshot should be called exactly once at startup; got ${batchSnapshotCalls}`
    );
  });

  it("second getStockUniverse call returns from cache in < 50 ms", async () => {
    const provider = new LiveMarketDataProvider("test-api-key", 10_000, 300);

    // First call populates the cache
    await provider.getStockUniverse();

    // Second call must come from cache — near-instant
    const start = Date.now();
    await provider.getStockUniverse();
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < 50,
      `cache hit should return in < 50 ms; took ${elapsed} ms`
    );
  });

  it("getOptionsChain maps top-level implied_volatility and open_interest fields", async () => {
    const provider = new LiveMarketDataProvider("test-api-key", 10_000, 300);
    const chain = await provider.getOptionsChain("AAPL");

    assert.ok(chain !== null, "should return chain for AAPL");
    assert.ok(chain.contracts.length > 0, "chain should have contracts");

    for (const c of chain.contracts) {
      // Mock returns IV = 0.30 (call) and 0.32 (put) at the top level
      assert.ok(
        c.callIV > 0,
        `callIV must map from top-level implied_volatility (got ${c.callIV})`
      );
      assert.ok(
        c.putIV > 0,
        `putIV must map from top-level implied_volatility (got ${c.putIV})`
      );
      assert.ok(
        c.callOI > 0,
        `callOI must map from top-level open_interest (got ${c.callOI})`
      );
    }
  });
});
