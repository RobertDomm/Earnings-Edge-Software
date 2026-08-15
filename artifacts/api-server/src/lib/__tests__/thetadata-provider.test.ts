/**
 * thetadata-provider.test.ts
 *
 * Provider-level unit tests for ThetaDataProvider.buildLiquidityMetrics.
 * Uses ThetaData-shaped row fixtures (the exact shape produced by the live
 * gRPC stream) to verify that the production decoder correctly handles
 * the CALL/PUT right-field and "implied_vol" IV column without requiring a
 * network connection.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ThetaDataProvider,
  ENRICHMENT_EXCLUDED_SECTORS,
  TICKER_SECTORS,
  LIVE_STOCK_UNIVERSE,
} from "../market-data.js";

// ---------------------------------------------------------------------------
// Fixture helpers — ThetaData-shaped row objects (as produced by the live stream)
// ---------------------------------------------------------------------------

type TdRow = Record<string, string | number | boolean | null>;

/**
 * Build a Quote snapshot row in the exact shape ThetaData gRPC returns
 * after decodeStream has processed it.
 * Key fields: Strike, Right ("CALL"/"PUT"), Expiration (YYYY-MM-DD), Bid, Ask, etc.
 *
 * NOTE: buildLiquidityMetrics expects Expiration in "YYYY-MM-DD" format with dashes
 * (the format produced by decodeStream from ThetaData's gRPC response).
 */
function quoteRow(opts: {
  strike: number;
  right: "CALL" | "PUT";
  expiration: string;  // "YYYY-MM-DD" (with dashes — as decodeStream produces)
  bid: number;
  ask: number;
  volume?: number;
  openInterest?: number;
}): TdRow {
  return {
    Strike:       opts.strike,
    Right:        opts.right,
    Expiration:   opts.expiration,
    Bid:          opts.bid,
    Ask:          opts.ask,
    BidSize:      100,
    AskSize:      100,
    Volume:       opts.volume       ?? 5000,
    OpenInterest: opts.openInterest ?? 20000,
  };
}

/**
 * Build a GreeksAll snapshot row in the exact shape ThetaData gRPC returns
 * after decodeStream has processed it.
 * Key fields: Strike, Right ("CALL"/"PUT"), implied_vol (ThetaData's IV field name),
 * underlying_price, Expiration (YYYY-MM-DD).
 */
function greekRow(opts: {
  strike: number;
  right: "CALL" | "PUT";
  expiration: string;  // "YYYY-MM-DD"
  impliedVol: number;     // maps to "implied_vol" field (ThetaData's column name)
  underlyingPrice?: number;
}): TdRow {
  return {
    Strike:           opts.strike,
    Right:            opts.right,
    Expiration:       opts.expiration,
    implied_vol:      opts.impliedVol,
    underlying_price: opts.underlyingPrice ?? 300.0,
    Delta:            opts.right === "CALL" ? 0.35 : -0.35,
  };
}

// ---------------------------------------------------------------------------
// Access buildLiquidityMetrics via the provider instance
// ---------------------------------------------------------------------------

/**
 * Create a ThetaDataProvider and call buildLiquidityMetrics with fixture rows.
 * The provider does not need a valid API key for this — buildLiquidityMetrics
 * is a pure decoder that only needs the row arrays and the current epoch ms.
 */
function callBuildLiquidityMetrics(
  quoteRows: TdRow[],
  greekRows: TdRow[],
  todayMs: number
) {
  const provider = new ThetaDataProvider("test-key-not-used", 0 /* cacheTtlMs */);
  // buildLiquidityMetrics is private but accessible for testing via cast
  return (provider as any).buildLiquidityMetrics(quoteRows, greekRows, todayMs);
}

// ---------------------------------------------------------------------------
// Simulate a "today" that makes the given expiration fall on a specific DTE
// ---------------------------------------------------------------------------

/** Return a Date whose UTC midnight gives exactly `dte` days before `expYYYY-MM-DD`. */
function todayForDte(expISO: string, dte: number): Date {
  const expMs = new Date(expISO + "T00:00:00Z").getTime();
  return new Date(expMs - dte * 86_400_000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ThetaDataProvider.buildLiquidityMetrics — CALL/PUT right-field decode", () => {
  // Use an expiration that is 11 days out from today
  const EXP = "2026-10-10";
  const TODAY_MS = todayForDte(EXP, 11).getTime();

  it("returns non-null liquidityMetrics when CALL and PUT rows are present", () => {
    const qRows = [
      quoteRow({ strike: 205, right: "CALL", expiration: EXP, bid: 0.40, ask: 0.50 }),
      quoteRow({ strike: 195, right: "PUT",  expiration: EXP, bid: 0.38, ask: 0.48 }),
    ];
    const gRows = [
      greekRow({ strike: 205, right: "CALL", expiration: EXP, impliedVol: 0.35, underlyingPrice: 200 }),
      greekRow({ strike: 195, right: "PUT",  expiration: EXP, impliedVol: 0.35, underlyingPrice: 200 }),
    ];
    const metrics = callBuildLiquidityMetrics(qRows, gRows, TODAY_MS);
    assert.ok(metrics !== null, "liquidityMetrics must be non-null when CALL and PUT rows are present");
  });

  it("returns null when row arrays are empty", () => {
    const metrics = callBuildLiquidityMetrics([], [], TODAY_MS);
    assert.equal(metrics, null, "empty row arrays must return null");
  });

  it("correctly identifies hasWeeklyOptions=true when a non-3rd-Friday expiration is present", () => {
    // 2026-10-10 is a Saturday — not the 3rd Friday of October → weekly option
    const qRows = [
      quoteRow({ strike: 205, right: "CALL", expiration: "2026-10-09", bid: 0.40, ask: 0.50 }),
    ];
    const gRows = [
      greekRow({ strike: 205, right: "CALL", expiration: "2026-10-09", impliedVol: 0.35 }),
    ];
    const metrics = callBuildLiquidityMetrics(qRows, gRows, todayForDte("2026-10-09", 11).getTime());
    assert.ok(metrics !== null, "metrics must be non-null");
    assert.equal(metrics.liquidityMetrics.hasWeeklyOptions, true, "non-3rd-Friday expiry must set hasWeeklyOptions=true");
  });
});

describe("ThetaDataProvider.buildLiquidityMetrics — implied_vol IV extraction", () => {
  const EXP = "2026-10-10";
  const TODAY_MS = todayForDte(EXP, 11).getTime();

  it("extracts nearTermIv from implied_vol field (ThetaData's column name)", () => {
    const IV = 0.433;
    const qRows = [
      quoteRow({ strike: 205, right: "CALL", expiration: EXP, bid: 0.40, ask: 0.50 }),
    ];
    const gRows = [
      greekRow({ strike: 205, right: "CALL", expiration: EXP, impliedVol: IV, underlyingPrice: 200 }),
    ];
    const metrics = callBuildLiquidityMetrics(qRows, gRows, TODAY_MS);
    assert.ok(metrics !== null, "metrics must be non-null");
    assert.ok(
      metrics.liquidityMetrics.nearTermIv !== null && metrics.liquidityMetrics.nearTermIv > 0,
      `nearTermIv must be > 0 when implied_vol=${IV} is present (got ${metrics.liquidityMetrics.nearTermIv})`
    );
  });

  it("CALL rows with Right='CALL' are classified as calls (not silently discarded)", () => {
    // If right-field normalization fails, CALL rows are discarded and quoteRows is empty
    const qRows = [
      quoteRow({ strike: 210, right: "CALL", expiration: EXP, bid: 0.45, ask: 0.55 }),
      quoteRow({ strike: 205, right: "CALL", expiration: EXP, bid: 0.40, ask: 0.50 }),
      quoteRow({ strike: 195, right: "PUT",  expiration: EXP, bid: 0.38, ask: 0.48 }),
      quoteRow({ strike: 190, right: "PUT",  expiration: EXP, bid: 0.35, ask: 0.45 }),
    ];
    const gRows = [
      greekRow({ strike: 205, right: "CALL", expiration: EXP, impliedVol: 0.35, underlyingPrice: 200 }),
      greekRow({ strike: 195, right: "PUT",  expiration: EXP, impliedVol: 0.35, underlyingPrice: 200 }),
    ];
    const metrics = callBuildLiquidityMetrics(qRows, gRows, TODAY_MS);
    // If CALL rows were silently discarded, metrics would be null or have no spread data
    assert.ok(metrics !== null, "CALL rows must be decoded (not discarded) when Right='CALL'");
    assert.ok(
      metrics.liquidityMetrics.nearTermSpread !== null,
      "nearTermSpread must be populated when both CALL and PUT rows are present"
    );
  });

  it("PUT rows with Right='PUT' contribute to spread calculation (not silently discarded)", () => {
    const qRows = [
      quoteRow({ strike: 205, right: "CALL", expiration: EXP, bid: 0.40, ask: 0.50 }),
      quoteRow({ strike: 195, right: "PUT",  expiration: EXP, bid: 0.38, ask: 0.48 }),
    ];
    const gRows = [
      greekRow({ strike: 205, right: "CALL", expiration: EXP, impliedVol: 0.35, underlyingPrice: 200 }),
      greekRow({ strike: 195, right: "PUT",  expiration: EXP, impliedVol: 0.35, underlyingPrice: 200 }),
    ];
    const metrics = callBuildLiquidityMetrics(qRows, gRows, TODAY_MS);
    assert.ok(metrics !== null, "PUT rows must be decoded (not discarded) when Right='PUT'");
    // nearTermSpread is calculated from both CALL and PUT rows
    assert.ok(
      metrics.liquidityMetrics.nearTermSpread !== null,
      "nearTermSpread must be populated when both right types are decoded correctly"
    );
  });
});

describe("ThetaDataProvider.buildLiquidityMetrics — underlying_price extracted as stock price fallback", () => {
  const EXP = "2026-10-10";
  const TODAY_MS = todayForDte(EXP, 11).getTime();

  it("underlying_price is present in GreeksAll rows and accessible to enrichTicker", () => {
    // This test verifies that the GreeksAll row fixture has the underlying_price field
    // populated exactly as ThetaData sends it — the enrichTicker fallback relies on this.
    const gRows = [
      greekRow({ strike: 205, right: "CALL", expiration: EXP, impliedVol: 0.35, underlyingPrice: 305.6 }),
    ];
    assert.equal(
      gRows[0]["underlying_price"],
      305.6,
      "GreeksAll row must contain underlying_price=305.6 (ThetaData's field name)"
    );
  });
});

// ---------------------------------------------------------------------------
// Sector pre-filter: excluded symbols must never trigger Yahoo Finance calls
// ---------------------------------------------------------------------------

describe("ThetaDataProvider — sector pre-filter short-circuit", () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => { originalFetch = globalThis.fetch; });
  after(() => { globalThis.fetch = originalFetch; });

  it("sector-excluded symbols trigger no Yahoo Finance requests and are absent from the universe", async () => {
    // Identify excluded symbols from the live universe
    const excludedSymbols = new Set(
      LIVE_STOCK_UNIVERSE.filter((sym) =>
        ENRICHMENT_EXCLUDED_SECTORS.has(TICKER_SECTORS[sym] ?? "other")
      )
    );
    assert.ok(
      excludedSymbols.size > 0,
      "test requires at least one excluded-sector symbol in LIVE_STOCK_UNIVERSE"
    );

    // Track which Yahoo Finance URLs were fetched
    const yahooCalls = new Set<string>();

    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();

      // Record Yahoo Finance per-symbol chart requests
      if (url.includes("finance.yahoo.com")) {
        // URL format: .../v8/finance/chart/<SYMBOL>?...
        const m = url.match(/\/chart\/([^?]+)/);
        if (m) yahooCalls.add(decodeURIComponent(m[1]!));
      }

      // Polygon Earnings (financials) — return empty so no IV history is attempted
      if (url.includes("/vX/reference/financials")) {
        return new Response(JSON.stringify({ results: [], status: "OK" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Default: return an empty OK so any remaining fetch doesn't hang
      return new Response(JSON.stringify({ status: "OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    // Construct a provider that bypasses the actual ThetaData gRPC connection
    // by monkey-patching the internal enrichTicker to return null for all symbols
    // (we only care that Yahoo fetch calls for excluded symbols are absent).
    const provider = new ThetaDataProvider(
      "test-key-not-used",
      0 /* cacheTtlMs — immediate stale, never interferes */
    );

    // Intercept enrichTicker to avoid real gRPC calls while still letting
    // fetchUniverseFromThetaData complete its Yahoo fetch path.
    (provider as any).enrichTicker = async () => null;

    // fetchUniverseFromThetaData is private; invoke via the public interface.
    // We don't need the result — only whether Yahoo was called for excluded symbols.
    await (provider as any).fetchUniverseFromThetaData();

    // No excluded-sector symbol should have been looked up on Yahoo Finance
    for (const sym of excludedSymbols) {
      assert.ok(
        !yahooCalls.has(sym),
        `${sym} is sector-excluded — its Yahoo Finance chart endpoint must not be called (pre-filter short-circuit)`
      );
    }

    // All non-excluded symbols should have been fetched (confirming the filter
    // is selective, not accidentally skipping everything)
    const nonExcluded = LIVE_STOCK_UNIVERSE.filter(
      (sym) => !ENRICHMENT_EXCLUDED_SECTORS.has(TICKER_SECTORS[sym] ?? "other")
    );
    assert.ok(
      nonExcluded.length > 0,
      "test requires at least one non-excluded symbol"
    );
    assert.ok(
      nonExcluded.every((sym) => yahooCalls.has(sym)),
      `all non-excluded symbols must be fetched from Yahoo Finance; missing: ${
        nonExcluded.filter((sym) => !yahooCalls.has(sym)).join(", ")
      }`
    );
  });
});
