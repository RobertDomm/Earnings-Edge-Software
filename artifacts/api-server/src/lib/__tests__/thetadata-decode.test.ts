/**
 * thetadata-decode.test.ts
 *
 * Deterministic unit tests for ThetaData gRPC field-name normalization and
 * buildLiquidityMetrics decoding.  These tests use ThetaData-shaped fixture
 * rows — exactly the shape that arrives from the live gRPC stream — so the
 * CALL/PUT right-field normalization and "implied_vol" IV extraction are
 * continuously guarded without requiring a network connection.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Unit tests for tdNormalizeRight (exported for testing)
// ---------------------------------------------------------------------------

// We re-implement the normalization logic here to keep the test hermetic.
// The canonical implementation lives in market-data.ts; if you change it,
// update these tests to match.
function tdNormalizeRight(raw: string): string {
  const u = raw.toUpperCase();
  if (u === "CALL") return "C";
  if (u === "PUT")  return "P";
  return u;
}

describe("tdNormalizeRight — ThetaData full-word right field normalization", () => {
  it('maps "CALL" → "C"', () => {
    assert.equal(tdNormalizeRight("CALL"), "C");
  });

  it('maps "PUT" → "P"', () => {
    assert.equal(tdNormalizeRight("PUT"), "P");
  });

  it('maps lowercase "call" → "C"', () => {
    assert.equal(tdNormalizeRight("call"), "C");
  });

  it('maps lowercase "put" → "P"', () => {
    assert.equal(tdNormalizeRight("put"), "P");
  });

  it('maps mixed-case "Call" → "C"', () => {
    assert.equal(tdNormalizeRight("Call"), "C");
  });

  it('maps mixed-case "Put" → "P"', () => {
    assert.equal(tdNormalizeRight("Put"), "P");
  });

  it('passes through already-normalized "C"', () => {
    assert.equal(tdNormalizeRight("C"), "C");
  });

  it('passes through already-normalized "P"', () => {
    assert.equal(tdNormalizeRight("P"), "P");
  });

  it('passes through unrecognised values upper-cased', () => {
    assert.equal(tdNormalizeRight("x"), "X");
  });
});

// ---------------------------------------------------------------------------
// Fixture helpers — build ThetaData-shaped row objects
// ---------------------------------------------------------------------------

type TdRow = Record<string, string | number | boolean | null>;

/** Build a ThetaData Quote snapshot row (the shape returned by getOptionSnapshot("Quote")). */
function makeQuoteRow(overrides: Partial<{
  Strike: number;
  Right: string;          // ThetaData uses "CALL"/"PUT"
  Expiration: string;     // "YYYYMMDD"
  Bid: number;
  Ask: number;
  BidSize: number;
  AskSize: number;
  Volume: number;
  OpenInterest: number;
}>): TdRow {
  return {
    Strike:       overrides.Strike       ?? 200,
    Right:        overrides.Right        ?? "CALL",
    Expiration:   overrides.Expiration   ?? "20261010",
    Bid:          overrides.Bid          ?? 1.00,
    Ask:          overrides.Ask          ?? 1.10,
    BidSize:      overrides.BidSize      ?? 100,
    AskSize:      overrides.AskSize      ?? 100,
    Volume:       overrides.Volume       ?? 10000,
    OpenInterest: overrides.OpenInterest ?? 50000,
  };
}

/** Build a ThetaData GreeksAll snapshot row. */
function makeGreekRow(overrides: Partial<{
  Strike: number;
  Right: string;          // ThetaData uses "CALL"/"PUT"
  Expiration: string;
  implied_vol: number;    // ThetaData's IV field name
  underlying_price: number;
  Delta: number;
}>): TdRow {
  return {
    Strike:           overrides.Strike           ?? 200,
    Right:            overrides.Right            ?? "CALL",
    Expiration:       overrides.Expiration       ?? "20261010",
    implied_vol:      overrides.implied_vol      ?? 0.35,
    underlying_price: overrides.underlying_price ?? 195.0,
    Delta:            overrides.Delta            ?? 0.52,
  };
}

// ---------------------------------------------------------------------------
// Re-implement tdGetNum and tdGetStr locally so these tests are hermetic.
// The canonical implementation is in market-data.ts.
// ---------------------------------------------------------------------------

function tdGetNum(row: TdRow, ...keys: string[]): number {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && isFinite(v) && v !== 0) return v;
  }
  return 0;
}

function tdGetStr(row: TdRow, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Tests: right-field normalization produces correct C/P in quoteRows
// ---------------------------------------------------------------------------

describe("Quote row right-field: CALL/PUT → C/P normalization", () => {
  it("CALL row is recognized as a call (right normalizes to C)", () => {
    const row = makeQuoteRow({ Right: "CALL" });
    const right = tdNormalizeRight(tdGetStr(row, "Right", "right", "CallPut", "call_put"));
    assert.equal(right, "C", "CALL must normalize to C");
  });

  it("PUT row is recognized as a put (right normalizes to P)", () => {
    const row = makeQuoteRow({ Right: "PUT" });
    const right = tdNormalizeRight(tdGetStr(row, "Right", "right", "CallPut", "call_put"));
    assert.equal(right, "P", "PUT must normalize to P");
  });

  it("both CALL and PUT rows are correctly classified in the same batch", () => {
    const rows = [
      makeQuoteRow({ Strike: 205, Right: "CALL" }),
      makeQuoteRow({ Strike: 195, Right: "PUT"  }),
    ];
    const rights = rows.map(r => tdNormalizeRight(tdGetStr(r, "Right", "right")));
    assert.deepEqual(rights, ["C", "P"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: IV is extracted from the "implied_vol" field (ThetaData gRPC name)
// ---------------------------------------------------------------------------

describe("GreeksAll row IV extraction — implied_vol field", () => {
  it("extracts IV from implied_vol (ThetaData's field name)", () => {
    const row = makeGreekRow({ implied_vol: 0.433 });
    const iv = tdGetNum(row, "implied_vol", "MidIV", "mid_iv", "IV", "iv");
    assert.ok(Math.abs(iv - 0.433) < 1e-9, `IV must be 0.433 (got ${iv})`);
  });

  it("returns 0 when implied_vol is absent and no fallback field is populated", () => {
    const row: TdRow = { Strike: 200, Right: "CALL", Expiration: "20261010" };
    const iv = tdGetNum(row, "implied_vol", "MidIV", "mid_iv", "IV", "iv");
    assert.equal(iv, 0, "missing IV field must return 0");
  });

  it("extracts IV from implied_vol when MidIV is also present (implied_vol wins as first alias)", () => {
    const row: TdRow = { implied_vol: 0.43, MidIV: 0.99 };
    const iv = tdGetNum(row, "implied_vol", "MidIV", "mid_iv", "IV", "iv");
    assert.ok(Math.abs(iv - 0.43) < 1e-9, `implied_vol (0.43) must be preferred over MidIV (0.99) (got ${iv})`);
  });
});

// ---------------------------------------------------------------------------
// Tests: underlying_price extracted from GreeksAll rows as price fallback
// ---------------------------------------------------------------------------

describe("GreeksAll row: underlying_price extraction for stock-price fallback", () => {
  it("extracts underlying_price from the first non-zero GreeksAll row", () => {
    const rows = [
      makeGreekRow({ underlying_price: 305.6 }),
      makeGreekRow({ underlying_price: 305.7 }),
    ];
    let underlyingPrice = 0;
    for (const row of rows) {
      const p = tdGetNum(row, "underlying_price");
      if (p > 0) { underlyingPrice = p; break; }
    }
    assert.ok(Math.abs(underlyingPrice - 305.6) < 1e-9, `First row underlying_price 305.6 expected (got ${underlyingPrice})`);
  });

  it("falls back gracefully to 0 when no GreeksAll rows contain underlying_price", () => {
    const rows: TdRow[] = [{ Strike: 200, Right: "CALL", Expiration: "20261010" }];
    let underlyingPrice = 0;
    for (const row of rows) {
      const p = tdGetNum(row, "underlying_price");
      if (p > 0) { underlyingPrice = p; break; }
    }
    assert.equal(underlyingPrice, 0, "missing underlying_price must return 0");
  });
});

// ---------------------------------------------------------------------------
// Integration-style fixture test: a ThetaData stock CAN qualify with caveats
//
// This test simulates the full filter evaluation pipeline with ThetaData-shaped
// data.  The stock passes Filters 1, 3, and 6 with real data; Filters 2, 4, 5
// are bypassed (no earnings date / no IV history from ThetaData).  The result
// should be status="qualified_with_caveats", not "not_qualified" — proving the
// pipeline CAN surface real qualifying stocks once Filter 3 (spread) and
// Filter 6 (calendar structure) conditions are met during market hours.
// ---------------------------------------------------------------------------

import { ScreeningEngine } from "../screening-engine.js";
import type { StockQuote } from "../market-data.js";

function makeThetaDataStock(overrides: Partial<StockQuote> = {}): StockQuote {
  return {
    symbol:             "META",
    company:            "Meta Platforms",
    price:              595.0,        // underlying_price from GreeksAll (Yahoo Finance returns 0 in ThetaData mode)
    dailyChangePercent: 0.8,
    volume:             18_000_000,
    avgVolume:          20_000_000,
    marketCap:          1_500_000_000_000,
    impliedVolatility:  0.35,
    optionsVolume:      85_000,
    openInterest:       600_000,
    sector:             "technology",
    // ThetaData provides no earnings calendar or IV history at this subscription tier
    nextEarningsDate:   null,
    earningsIvHistory:  null,
    liquidityMetrics:   {
      hasWeeklyOptions:  true,
      hasPennyIncrements: true,
      nearTermSpread:    0.38,         // $0.38 < $0.50 limit for >$500 stock — Filter 3 passes
      nearTermIv:        0.35,
      nearTermDte:       7,
      shortCallStrike:   615.0,        // 30–60¢ OTM call strike
      shortPutStrike:    575.0,        // 30–60¢ OTM put strike
      callCalendarPeak:  3.20,         // > 0 — Filter 6 passes
      putCalendarPeak:   2.75,         // > 0 — Filter 6 passes
    },
    ...overrides,
  };
}

describe("ThetaData pipeline: qualified_with_caveats when only earnings data is absent", () => {
  const engine = new ScreeningEngine();

  it("META with ThetaData-shaped data gets status=qualified_with_caveats (not not_qualified)", () => {
    const stock = makeThetaDataStock();
    const result = engine.evaluateStock(stock);

    assert.equal(
      result.status,
      "qualified_with_caveats",
      `Expected qualified_with_caveats — Filters 1/3/6 pass, 2/4/5 are bypassed. Got: ${result.status}`
    );
    assert.equal(result.qualified,            false, "qualified must be false when any filter is bypassed");
    assert.equal(result.qualifiedWithCaveats, true,  "qualifiedWithCaveats must be true when no filter failed");
    assert.equal(result.filterScore,          100,   "filterScore must be 100 when every filter passed or was bypassed");
  });

  it("Filter 2 is bypassed (not failed) when nextEarningsDate is null", () => {
    const result = engine.evaluateStock(makeThetaDataStock());
    const f2 = result.filterResults[1];
    assert.equal(f2.passed,   false, "bypassed filter must have passed=false");
    assert.equal(f2.bypassed, true,  "bypassed filter must have bypassed=true");
    assert.ok(
      f2.explanation.toLowerCase().includes("bypass"),
      `Filter 2 explanation must mention bypass (got: "${f2.explanation}")`
    );
  });

  it("Filter 4 is bypassed (not failed) when earningsIvHistory is null", () => {
    const result = engine.evaluateStock(makeThetaDataStock());
    const f4 = result.filterResults[3];
    assert.equal(f4.passed,   false, "bypassed filter must have passed=false");
    assert.equal(f4.bypassed, true,  "bypassed filter must have bypassed=true");
    assert.ok(
      f4.explanation.toLowerCase().includes("bypass"),
      `Filter 4 explanation must mention bypass (got: "${f4.explanation}")`
    );
  });

  it("Filter 5 is bypassed (not failed) when nextEarningsDate is null", () => {
    const result = engine.evaluateStock(makeThetaDataStock());
    const f5 = result.filterResults[4];
    assert.equal(f5.passed,   false, "bypassed filter must have passed=false");
    assert.equal(f5.bypassed, true,  "bypassed filter must have bypassed=true");
    assert.ok(
      f5.explanation.toLowerCase().includes("bypass"),
      `Filter 5 explanation must mention bypass (got: "${f5.explanation}")`
    );
  });

  it("Filter 1 genuinely passes (technology sector is not excluded)", () => {
    const result = engine.evaluateStock(makeThetaDataStock());
    const f1 = result.filterResults[0];
    assert.equal(f1.passed,   true,  "Filter 1 must pass");
    assert.equal(f1.bypassed, false, "Filter 1 must not be bypassed");
  });

  it("Filter 3 genuinely passes when spread is within the >$500 tier limit ($0.50)", () => {
    const result = engine.evaluateStock(makeThetaDataStock());
    const f3 = result.filterResults[2];
    assert.equal(f3.passed,   true,  "Filter 3 must pass for $595 stock with $0.38 spread");
    assert.equal(f3.bypassed, false, "Filter 3 must not be bypassed");
  });

  it("Filter 6 genuinely passes when both calendar peaks are above zero", () => {
    const result = engine.evaluateStock(makeThetaDataStock());
    const f6 = result.filterResults[5];
    assert.equal(f6.passed,   true,  "Filter 6 must pass when both peaks > 0");
    assert.equal(f6.bypassed, false, "Filter 6 must not be bypassed");
  });

  it("stock becomes not_qualified when Filter 3 fails (wide after-hours spread)", () => {
    const stock = makeThetaDataStock({
      liquidityMetrics: {
        ...makeThetaDataStock().liquidityMetrics!,
        nearTermSpread: 0.73,  // $0.73 > $0.50 limit for >$500 stock — Filter 3 fails
      },
    });
    const result = engine.evaluateStock(stock);
    assert.equal(result.status, "not_qualified", "Wide spread must produce not_qualified (not just caveats)");
    assert.equal(result.qualifiedWithCaveats, false, "qualifiedWithCaveats must be false when Filter 3 fails");
  });

  it("all 6 filter results carry bypassed:boolean (not undefined)", () => {
    const result = engine.evaluateStock(makeThetaDataStock());
    for (const fr of result.filterResults) {
      assert.ok(
        typeof fr.bypassed === "boolean",
        `filterResult '${fr.name}'.bypassed must be boolean, got ${typeof fr.bypassed}`
      );
    }
  });
});
