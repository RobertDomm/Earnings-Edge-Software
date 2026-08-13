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
import {
  fetchPolygonEarningsData,
  fetchPolygonEarningsDataCached,
  clearPolygonEarningsCache,
  ThetaDataProvider,
} from "../market-data.js";
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

// ---------------------------------------------------------------------------
// fetchPolygonEarningsData — integration probe with stubbed Polygon HTTP
//
// Verifies that when both THETADATA_API_KEY and MARKET_DATA_API_KEY are
// active, the Polygon supplementary call correctly populates
// nextEarningsDate and earningsIvHistory (non-null).
// ---------------------------------------------------------------------------

/**
 * Build a set of synthetic daily price bars for `fetchPolygonEarningsData`
 * that guarantee non-zero realizedVol in both the pre-earnings window
 * (daysTo 2–7, high swings → high vol) and the baseline window
 * (daysTo 15–40, tiny alternation → low vol), so that ivBefore > ivBaseline
 * for every filing date (ivRose: true for all four cycles).
 *
 * Dates are generated from LOCAL midnight timestamps (matching the
 * `new Date(date + "T00:00:00")` pattern used inside the function).
 */
function makeStubBars(filings: string[]): Array<{ t: number; c: number }> {
  const bars: Array<{ t: number; c: number }> = [];
  const seenMs = new Set<number>();

  // High-swing prices for the pre-earnings window (6 prices → 5 log-returns)
  const preClosePrices = [100, 107, 92, 109, 90, 111];

  for (const filing of filings) {
    // Use local midnight — same convention as fetchPolygonEarningsData
    const earningsMs = new Date(filing + "T00:00:00").getTime();

    // Pre window: daysTo 7, 6, 5, 4, 3, 2
    for (let i = 0; i < preClosePrices.length; i++) {
      const d = 7 - i;
      const ms = earningsMs - d * 86_400_000;
      if (!seenMs.has(ms)) {
        seenMs.add(ms);
        bars.push({ t: ms, c: preClosePrices[i]! });
      }
    }

    // Base window: daysTo 40 down to 15 (26 prices → 25 log-returns)
    // Alternate 100.1 / 99.9 → small but non-zero variance
    for (let i = 0; i < 26; i++) {
      const d = 40 - i;
      const ms = earningsMs - d * 86_400_000;
      if (!seenMs.has(ms)) {
        seenMs.add(ms);
        bars.push({ t: ms, c: i % 2 === 0 ? 100.1 : 99.9 });
      }
    }
  }

  return bars.sort((a, b) => a.t - b.t);
}

/**
 * The four past quarterly filing dates used in the stub.
 * Most-recent first — the same order Polygon returns them.
 */
const STUB_FILINGS = [
  { filing_date: "2026-05-01" },
  { filing_date: "2026-02-01" },
  { filing_date: "2025-11-01" },
  { filing_date: "2025-08-01" },
];

const STUB_BARS = makeStubBars(STUB_FILINGS.map((f) => f.filing_date));

/**
 * Minimal `Response`-compatible object for Node.js's built-in fetch mock.
 */
function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe("fetchPolygonEarningsData — stub Polygon HTTP (both API keys active)", () => {
  let originalFetch: typeof globalThis.fetch;

  // Install a deterministic fetch stub before each test in this suite.
  // Restored after each test so other suites are unaffected.
  function installStubFetch(): void {
    originalFetch = globalThis.fetch;
    const stub: typeof globalThis.fetch = async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url.includes("/vX/reference/financials")) {
        return makeJsonResponse({ results: STUB_FILINGS, status: "OK" });
      }
      if (url.includes("/v2/aggs/ticker/")) {
        return makeJsonResponse({ results: STUB_BARS, status: "OK" });
      }
      return makeJsonResponse({ error: "stub: unrecognised path" }, 404);
    };
    globalThis.fetch = stub;
  }

  function restoreFetch(): void {
    globalThis.fetch = originalFetch;
  }

  it("returns non-null nextEarningsDate when Polygon returns 4 quarterly filings", async () => {
    installStubFetch();
    try {
      const result = await fetchPolygonEarningsData("stub-key", "META");
      assert.ok(
        result.nextEarningsDate !== null,
        `nextEarningsDate must be non-null when Polygon returns 4 filings (got ${result.nextEarningsDate})`
      );
      // Should be the most-recent filing date + 91 days
      assert.match(
        result.nextEarningsDate!,
        /^\d{4}-\d{2}-\d{2}$/,
        "nextEarningsDate must be a YYYY-MM-DD string"
      );
    } finally {
      restoreFetch();
    }
  });

  it("returns non-null earningsIvHistory with 4 records when price aggregates cover all windows", async () => {
    installStubFetch();
    try {
      const result = await fetchPolygonEarningsData("stub-key", "META");
      assert.ok(
        result.earningsIvHistory !== null,
        "earningsIvHistory must be non-null when 4 filings and covering price bars are provided"
      );
      assert.equal(
        result.earningsIvHistory!.length,
        4,
        `earningsIvHistory must contain 4 records (one per filing) — got ${result.earningsIvHistory!.length}`
      );
    } finally {
      restoreFetch();
    }
  });

  it("each EarningsIvRecord has numeric ivBeforeEarnings, ivBaseline, and boolean ivRose", async () => {
    installStubFetch();
    try {
      const result = await fetchPolygonEarningsData("stub-key", "META");
      for (const rec of result.earningsIvHistory ?? []) {
        assert.ok(
          typeof rec.ivBeforeEarnings === "number" && rec.ivBeforeEarnings > 0,
          `ivBeforeEarnings must be a positive number (got ${rec.ivBeforeEarnings})`
        );
        assert.ok(
          typeof rec.ivBaseline === "number" && rec.ivBaseline > 0,
          `ivBaseline must be a positive number (got ${rec.ivBaseline})`
        );
        assert.equal(typeof rec.ivRose, "boolean", "ivRose must be boolean");
      }
    } finally {
      restoreFetch();
    }
  });

  it("ivBeforeEarnings > ivBaseline for all 4 cycles (high pre-earnings vol confirmed)", async () => {
    installStubFetch();
    try {
      const result = await fetchPolygonEarningsData("stub-key", "META");
      for (const rec of result.earningsIvHistory ?? []) {
        assert.ok(
          rec.ivBeforeEarnings > rec.ivBaseline,
          `Expected ivBeforeEarnings (${rec.ivBeforeEarnings}) > ivBaseline (${rec.ivBaseline}) for ${rec.earningsDate}`
        );
        assert.equal(rec.ivRose, true, `ivRose must be true when ivBeforeEarnings > ivBaseline (${rec.earningsDate})`);
      }
    } finally {
      restoreFetch();
    }
  });

  it("returns null nextEarningsDate and null earningsIvHistory when Polygon financials call fails", async () => {
    installStubFetch();
    // Override: financials returns HTTP 500
    const failFinancials: typeof globalThis.fetch = async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url.includes("/vX/reference/financials")) {
        return makeJsonResponse({ error: "internal error" }, 500);
      }
      return makeJsonResponse({ results: STUB_BARS }, 200);
    };
    globalThis.fetch = failFinancials;
    try {
      const result = await fetchPolygonEarningsData("stub-key", "META");
      assert.equal(result.nextEarningsDate, null, "nextEarningsDate must be null when financials call fails");
      assert.equal(result.earningsIvHistory, null, "earningsIvHistory must be null when financials call fails");
    } finally {
      restoreFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// fetchPolygonEarningsData — retry, error logging, and per-ticker caching
// ---------------------------------------------------------------------------

describe("fetchPolygonEarningsData — retry and error logging", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWarn: typeof console.warn;
  let warnings: string[];

  function setup(stub: typeof globalThis.fetch): void {
    originalFetch = globalThis.fetch;
    originalWarn = console.warn;
    warnings = [];
    globalThis.fetch = stub;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  }

  function teardown(): void {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }

  const FAST = { retryBaseMs: 1 }; // keep test backoff delays negligible

  it("retries a 429 and succeeds on the second attempt", async () => {
    let financialsCalls = 0;
    setup(async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url.includes("/vX/reference/financials")) {
        financialsCalls++;
        if (financialsCalls === 1) return makeJsonResponse({ error: "rate limit" }, 429);
        return makeJsonResponse({ results: STUB_FILINGS, status: "OK" });
      }
      if (url.includes("/v2/aggs/ticker/")) return makeJsonResponse({ results: STUB_BARS, status: "OK" });
      return makeJsonResponse({ error: "stub: unrecognised path" }, 404);
    });
    try {
      const result = await fetchPolygonEarningsData("stub-key", "META", FAST);
      assert.equal(financialsCalls, 2, "must retry once after the 429");
      assert.ok(result.nextEarningsDate !== null, "must succeed after retry");
      assert.equal(warnings.length, 0, "no warning when retry succeeds");
    } finally {
      teardown();
    }
  });

  it("gives up after retries and logs a classified throttling warning", async () => {
    let financialsCalls = 0;
    setup(async () => { financialsCalls++; return makeJsonResponse({ error: "rate limit" }, 429); });
    try {
      const result = await fetchPolygonEarningsData("stub-key", "NVDA", { ...FAST, retries: 2 });
      assert.equal(financialsCalls, 3, "1 initial + 2 retries");
      assert.equal(result.nextEarningsDate, null);
      assert.equal(warnings.length, 1, "exactly one warning after exhausting retries");
      assert.match(warnings[0]!, /NVDA/, "warning must name the ticker");
      assert.match(warnings[0]!, /throttled \(429\)/, "warning must classify the failure as throttling");
    } finally {
      teardown();
    }
  });

  it("does NOT retry auth errors and logs an auth-classified warning", async () => {
    let financialsCalls = 0;
    setup(async () => { financialsCalls++; return makeJsonResponse({ error: "unauthorized" }, 401); });
    try {
      const result = await fetchPolygonEarningsData("stub-key", "AMD", FAST);
      assert.equal(financialsCalls, 1, "auth failures must not be retried");
      assert.equal(result.nextEarningsDate, null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /auth error \(401\)/, "warning must classify the failure as auth");
    } finally {
      teardown();
    }
  });

  it("logs a warning when Polygon returns zero filings", async () => {
    setup(async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url.includes("/vX/reference/financials")) return makeJsonResponse({ results: [], status: "OK" });
      return makeJsonResponse({ error: "stub: unrecognised path" }, 404);
    });
    try {
      const result = await fetchPolygonEarningsData("stub-key", "TSLA", FAST);
      assert.equal(result.nextEarningsDate, null);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /no quarterly filings/, "warning must state that no filings were returned");
    } finally {
      teardown();
    }
  });
});

describe("fetchPolygonEarningsDataCached — per-ticker 24h cache", () => {
  let originalFetch: typeof globalThis.fetch;

  function countingStub(counter: { calls: number }, ok = true): typeof globalThis.fetch {
    return async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url.includes("/vX/reference/financials")) {
        counter.calls++;
        return ok
          ? makeJsonResponse({ results: STUB_FILINGS, status: "OK" })
          : makeJsonResponse({ error: "boom" }, 500);
      }
      if (url.includes("/v2/aggs/ticker/")) return makeJsonResponse({ results: STUB_BARS, status: "OK" });
      return makeJsonResponse({ error: "stub: unrecognised path" }, 404);
    };
  }

  it("serves the second lookup for the same ticker from cache (no second HTTP call)", async () => {
    clearPolygonEarningsCache();
    const counter = { calls: 0 };
    originalFetch = globalThis.fetch;
    globalThis.fetch = countingStub(counter);
    try {
      const first  = await fetchPolygonEarningsDataCached("stub-key", "META", { retryBaseMs: 1 });
      const second = await fetchPolygonEarningsDataCached("stub-key", "META", { retryBaseMs: 1 });
      assert.equal(counter.calls, 1, "second call must be served from cache");
      assert.deepEqual(second, first, "cached result must equal the original");
    } finally {
      globalThis.fetch = originalFetch;
      clearPolygonEarningsCache();
    }
  });

  it("LiveMarketDataProvider.fetchEarningsData reuses the cache across refreshes (no repeat HTTP calls)", async () => {
    clearPolygonEarningsCache();
    const counter = { calls: 0 };
    originalFetch = globalThis.fetch;
    globalThis.fetch = countingStub(counter);
    try {
      const { LiveMarketDataProvider } = await import("../market-data.js");
      const provider = new LiveMarketDataProvider("stub-key", 0, 300);
      // Access the private per-ticker earnings helper the refresh cycle uses.
      const fetchEarnings = (provider as unknown as {
        fetchEarningsData(t: string): Promise<{ nextEarningsDate: string | null }>;
      }).fetchEarningsData.bind(provider);

      const first  = await fetchEarnings("META");
      const second = await fetchEarnings("META");
      assert.ok(first.nextEarningsDate !== null, "first lookup must succeed");
      assert.equal(counter.calls, 1, "second refresh must be served from the 24h cache — no repeat financials call");
      assert.deepEqual(second, first);
    } finally {
      globalThis.fetch = originalFetch;
      clearPolygonEarningsCache();
    }
  });

  it("does NOT cache failures — next call retries the fetch", async () => {
    clearPolygonEarningsCache();
    const counter = { calls: 0 };
    const originalWarn = console.warn;
    console.warn = () => {};
    originalFetch = globalThis.fetch;
    globalThis.fetch = countingStub(counter, false);
    try {
      const first = await fetchPolygonEarningsDataCached("stub-key", "META", { retries: 0, retryBaseMs: 1 });
      assert.equal(first.nextEarningsDate, null);
      const callsAfterFirst = counter.calls;
      await fetchPolygonEarningsDataCached("stub-key", "META", { retries: 0, retryBaseMs: 1 });
      assert.ok(counter.calls > callsAfterFirst, "failed lookups must not be cached");
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      clearPolygonEarningsCache();
    }
  });
});

// ---------------------------------------------------------------------------
// ScreeningEngine: Filters 2, 4, 5 not bypassed when both API keys are active
//
// Simulates the StockQuote that ThetaDataProvider.enrichTicker produces when
// MARKET_DATA_API_KEY is set alongside THETADATA_API_KEY.  Both earnings
// fields are non-null, so the filters must evaluate (bypassed: false)
// regardless of whether they pass or fail.
// ---------------------------------------------------------------------------

/**
 * Stock shaped as ThetaDataProvider.enrichTicker would return it when
 * both THETADATA_API_KEY and MARKET_DATA_API_KEY are set.
 * Earnings date is squarely in the 14–18 day window so F2 and F5 also pass.
 */
/** Returns a YYYY-MM-DD string that is `days` calendar days from today. */
function daysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0]!;
}

function makeThetaDataStockWithPolygon(overrides: Partial<StockQuote> = {}): StockQuote {
  return {
    // Use the same structural base as makeThetaDataStock() …
    ...makeThetaDataStock(),
    // … but override the two fields that Polygon now supplies:
    nextEarningsDate:  daysFromToday(14),  // always 14 days from today → inside F2/F5 window
    earningsIvHistory: [              // 4/4 ivRose → F4 passes
      { earningsDate: "2025-08-01", ivBaseline: 0.28, ivBeforeEarnings: 0.45, ivRose: true },
      { earningsDate: "2025-11-01", ivBaseline: 0.31, ivBeforeEarnings: 0.49, ivRose: true },
      { earningsDate: "2026-02-01", ivBaseline: 0.26, ivBeforeEarnings: 0.42, ivRose: true },
      { earningsDate: "2026-05-01", ivBaseline: 0.29, ivBeforeEarnings: 0.46, ivRose: true },
    ],
    ...overrides,
  };
}

describe("ThetaData + Polygon mode: Filters 2, 4, 5 not bypassed when earnings data is present", () => {
  const engine = new ScreeningEngine();

  it("Filter 2 has bypassed:false when nextEarningsDate is non-null", () => {
    const result = engine.evaluateStock(makeThetaDataStockWithPolygon());
    const f2 = result.filterResults[1];
    assert.equal(
      f2.bypassed,
      false,
      `Filter 2 must NOT be bypassed when nextEarningsDate is present (got bypassed=${f2.bypassed}, explanation="${f2.explanation}")`
    );
  });

  it("Filter 4 has bypassed:false when earningsIvHistory is non-null", () => {
    const result = engine.evaluateStock(makeThetaDataStockWithPolygon());
    const f4 = result.filterResults[3];
    assert.equal(
      f4.bypassed,
      false,
      `Filter 4 must NOT be bypassed when earningsIvHistory is present (got bypassed=${f4.bypassed}, explanation="${f4.explanation}")`
    );
  });

  it("Filter 5 has bypassed:false when nextEarningsDate is non-null", () => {
    const result = engine.evaluateStock(makeThetaDataStockWithPolygon());
    const f5 = result.filterResults[4];
    assert.equal(
      f5.bypassed,
      false,
      `Filter 5 must NOT be bypassed when nextEarningsDate is present (got bypassed=${f5.bypassed}, explanation="${f5.explanation}")`
    );
  });

  it("Filter 2 genuinely passes when earnings date is 14 days out", () => {
    const result = engine.evaluateStock(makeThetaDataStockWithPolygon());
    const f2 = result.filterResults[1];
    assert.equal(f2.passed, true, `Filter 2 must pass when earnings are 14 days away (got: ${f2.explanation})`);
  });

  it("Filter 4 genuinely passes when all 4 IV cycles show ivRose:true", () => {
    const result = engine.evaluateStock(makeThetaDataStockWithPolygon());
    const f4 = result.filterResults[3];
    assert.equal(f4.passed, true, `Filter 4 must pass with 4/4 ivRose cycles (got: ${f4.explanation})`);
  });

  it("Filter 5 genuinely passes when earnings date is 14 days out", () => {
    const result = engine.evaluateStock(makeThetaDataStockWithPolygon());
    const f5 = result.filterResults[4];
    assert.equal(f5.passed, true, `Filter 5 must pass when earnings are 14 days away (got: ${f5.explanation})`);
  });

  it("stock is fully qualified (not just caveats) when all 6 filters pass", () => {
    const result = engine.evaluateStock(makeThetaDataStockWithPolygon());
    assert.equal(
      result.status,
      "qualified",
      `Expected status=qualified when all 6 filters pass (got: ${result.status})`
    );
    assert.equal(result.qualified, true, "qualified must be true");
    assert.equal(result.qualifiedWithCaveats, false, "qualifiedWithCaveats must be false when no filter was bypassed");
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation: when polygonApiKey is null (MARKET_DATA_API_KEY not
// set), ThetaDataProvider leaves nextEarningsDate and earningsIvHistory as
// null.  Filters 2, 4, 5 must continue to bypass rather than crash.
// ---------------------------------------------------------------------------

describe("Graceful degradation: null polygonApiKey → Filters 2, 4, 5 still bypass (no crash)", () => {
  const engine = new ScreeningEngine();

  it("Filter 2 is bypassed (not failed) when nextEarningsDate is null (no Polygon key)", () => {
    // makeThetaDataStock() produces null nextEarningsDate — models polygonApiKey:null
    const result = engine.evaluateStock(makeThetaDataStock({ nextEarningsDate: null }));
    const f2 = result.filterResults[1];
    assert.equal(f2.bypassed, true,  "Filter 2 must be bypassed when nextEarningsDate is null");
    assert.equal(f2.passed,   false, "bypassed filter must have passed:false");
  });

  it("Filter 4 is bypassed (not failed) when earningsIvHistory is null (no Polygon key)", () => {
    const result = engine.evaluateStock(makeThetaDataStock({ earningsIvHistory: null }));
    const f4 = result.filterResults[3];
    assert.equal(f4.bypassed, true,  "Filter 4 must be bypassed when earningsIvHistory is null");
    assert.equal(f4.passed,   false, "bypassed filter must have passed:false");
  });

  it("Filter 5 is bypassed (not failed) when nextEarningsDate is null (no Polygon key)", () => {
    const result = engine.evaluateStock(makeThetaDataStock({ nextEarningsDate: null }));
    const f5 = result.filterResults[4];
    assert.equal(f5.bypassed, true,  "Filter 5 must be bypassed when nextEarningsDate is null");
    assert.equal(f5.passed,   false, "bypassed filter must have passed:false");
  });

  it("status is qualified_with_caveats (not not_qualified) — bypass does not disqualify", () => {
    const result = engine.evaluateStock(makeThetaDataStock());
    assert.equal(
      result.status,
      "qualified_with_caveats",
      `Expected qualified_with_caveats when only earnings data is absent (got: ${result.status})`
    );
  });

  it("evaluateStock does not throw when both earnings fields are null", () => {
    assert.doesNotThrow(() => {
      engine.evaluateStock(makeThetaDataStock({ nextEarningsDate: null, earningsIvHistory: null }));
    }, "evaluateStock must not throw when earnings data is null (polygonApiKey: null path)");
  });
});

// ---------------------------------------------------------------------------
// Provider-level wiring test: ThetaDataProvider.enrichTicker propagates
// Polygon earnings data when polygonApiKey is non-null
//
// This verifies the critical wiring inside enrichTicker — the path from
// "polygonApiKey is set" → "fetchPolygonEarningsData is called" → "the
// resulting nextEarningsDate and earningsIvHistory reach the StockQuote".
// A regression that broke this propagation would silently keep returning
// null earnings fields even when MARKET_DATA_API_KEY is configured.
//
// Approach: construct a real ThetaDataProvider with a stub fetch (covering
// ThetaData auth + Polygon endpoints) and a stub getOptionSnapshot (bypasses
// the gRPC layer), then invoke the private enrichTicker via cast.
// ---------------------------------------------------------------------------

/**
 * Minimal ThetaData GreeksAll row — enough for enrichTicker to proceed past
 * the `if (quoteRows.length === 0 && greekRows.length === 0) return null` guard.
 */
const PROVIDER_GREEK_ROW = {
  Strike:           600,
  Right:            "CALL",
  Expiration:       "2026-10-10",
  implied_vol:      0.35,
  underlying_price: 595.0,
  Delta:            0.35,
};

describe("ThetaDataProvider.enrichTicker wiring: polygonApiKey propagates to StockQuote", () => {
  it("quote.nextEarningsDate is non-null when polygonApiKey is set (end-to-end wiring confirmed)", async () => {
    const origFetch = globalThis.fetch;

    // Install stub before constructing ThetaDataProvider — doInit() runs immediately
    // in the constructor and calls fetch for the ThetaData auth.
    const stubFetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      // ThetaData nexus auth
      if (url.includes("nexus-api.thetadata.us")) {
        return makeJsonResponse({ sessionId: "stub-session", user: { email: "stub@test.com" } });
      }
      // Polygon financials → 4 quarterly filings
      if (url.includes("/vX/reference/financials")) {
        return makeJsonResponse({ results: STUB_FILINGS, status: "OK" });
      }
      // Polygon price aggregates → synthetic bars
      if (url.includes("/v2/aggs/ticker/")) {
        return makeJsonResponse({ results: STUB_BARS, status: "OK" });
      }
      return makeJsonResponse({ error: "stub: unrecognised" }, 404);
    };
    globalThis.fetch = stubFetch;

    try {
      // cacheTtlSeconds=0 keeps the cache always stale (won't auto-refresh in test).
      // polygonApiKey="stub-poly-key" is the key condition being tested.
      const provider = new ThetaDataProvider("stub-td-key", 0, "stub-poly-key");

      // Override getOptionSnapshot AFTER construction so enrichTicker never reaches
      // the real gRPC layer.  Return one GreeksAll row so the null-check passes.
      (provider as any).getOptionSnapshot = async (type: string) =>
        type === "GreeksAll" ? [PROVIDER_GREEK_ROW] : [];

      // Wait for doInit() to settle (auth succeeds via stub).
      await (provider as any).initPromise.catch(() => {});

      // Pre-built Yahoo data map (enrichTicker takes it as a parameter).
      const yahooMap = new Map([
        ["META", { price: 595, changePercent: 0.8, volume: 18_000_000, avgVolume: 20_000_000, marketCap: 1_500_000_000_000 }],
      ]);

      const quote: StockQuote | null = await (provider as any).enrichTicker("META", yahooMap, Date.now());

      assert.ok(
        quote !== null,
        "enrichTicker must return a non-null StockQuote when GreeksAll rows are present"
      );
      assert.ok(
        quote!.nextEarningsDate !== null,
        `nextEarningsDate must be non-null when polygonApiKey is set — ` +
        `a null here means enrichTicker is not calling fetchPolygonEarningsData ` +
        `(got ${quote!.nextEarningsDate})`
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("quote.earningsIvHistory is non-null when polygonApiKey is set and price bars cover all windows", async () => {
    const origFetch = globalThis.fetch;

    const stubFetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url.includes("nexus-api.thetadata.us")) {
        return makeJsonResponse({ sessionId: "stub-session", user: { email: "stub@test.com" } });
      }
      if (url.includes("/vX/reference/financials")) {
        return makeJsonResponse({ results: STUB_FILINGS, status: "OK" });
      }
      if (url.includes("/v2/aggs/ticker/")) {
        return makeJsonResponse({ results: STUB_BARS, status: "OK" });
      }
      return makeJsonResponse({ error: "stub: unrecognised" }, 404);
    };
    globalThis.fetch = stubFetch;

    try {
      const provider = new ThetaDataProvider("stub-td-key", 0, "stub-poly-key");
      (provider as any).getOptionSnapshot = async (type: string) =>
        type === "GreeksAll" ? [PROVIDER_GREEK_ROW] : [];
      await (provider as any).initPromise.catch(() => {});

      const yahooMap = new Map([
        ["META", { price: 595, changePercent: 0.8, volume: 18_000_000, avgVolume: 20_000_000, marketCap: 1_500_000_000_000 }],
      ]);
      const quote: StockQuote | null = await (provider as any).enrichTicker("META", yahooMap, Date.now());

      assert.ok(quote !== null, "enrichTicker must return a non-null StockQuote");
      assert.ok(
        quote!.earningsIvHistory !== null,
        `earningsIvHistory must be non-null when polygonApiKey is set and price bars cover all windows ` +
        `(got ${JSON.stringify(quote!.earningsIvHistory)})`
      );
      assert.equal(
        quote!.earningsIvHistory!.length,
        4,
        `earningsIvHistory must contain 4 records (got ${quote!.earningsIvHistory!.length})`
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("Filters 2, 4, 5 have bypassed:false on the StockQuote produced by enrichTicker with polygonApiKey set", async () => {
    const origFetch = globalThis.fetch;

    const stubFetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url.includes("nexus-api.thetadata.us")) {
        return makeJsonResponse({ sessionId: "stub-session", user: { email: "stub@test.com" } });
      }
      if (url.includes("/vX/reference/financials")) {
        return makeJsonResponse({ results: STUB_FILINGS, status: "OK" });
      }
      if (url.includes("/v2/aggs/ticker/")) {
        return makeJsonResponse({ results: STUB_BARS, status: "OK" });
      }
      return makeJsonResponse({ error: "stub: unrecognised" }, 404);
    };
    globalThis.fetch = stubFetch;

    try {
      const provider = new ThetaDataProvider("stub-td-key", 0, "stub-poly-key");
      (provider as any).getOptionSnapshot = async (type: string) =>
        type === "GreeksAll" ? [PROVIDER_GREEK_ROW] : [];
      await (provider as any).initPromise.catch(() => {});

      const yahooMap = new Map([
        ["META", { price: 595, changePercent: 0.8, volume: 18_000_000, avgVolume: 20_000_000, marketCap: 1_500_000_000_000 }],
      ]);
      const quote: StockQuote | null = await (provider as any).enrichTicker("META", yahooMap, Date.now());
      assert.ok(quote !== null, "enrichTicker must return a non-null StockQuote");

      // Run the real ScreeningEngine on the quote produced by enrichTicker
      const engine = new ScreeningEngine();
      const result = engine.evaluateStock(quote!);

      const [f2, f4, f5] = [result.filterResults[1], result.filterResults[3], result.filterResults[4]];

      assert.equal(
        f2.bypassed, false,
        `Filter 2 must not be bypassed on a quote produced by enrichTicker with polygonApiKey set ` +
        `(got bypassed=${f2.bypassed}, explanation="${f2.explanation}")`
      );
      assert.equal(
        f4.bypassed, false,
        `Filter 4 must not be bypassed on a quote produced by enrichTicker with polygonApiKey set ` +
        `(got bypassed=${f4.bypassed}, explanation="${f4.explanation}")`
      );
      assert.equal(
        f5.bypassed, false,
        `Filter 5 must not be bypassed on a quote produced by enrichTicker with polygonApiKey set ` +
        `(got bypassed=${f5.bypassed}, explanation="${f5.explanation}")`
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("quote.nextEarningsDate and earningsIvHistory are null when polygonApiKey is null (no Polygon key)", async () => {
    const origFetch = globalThis.fetch;

    // Stub only the ThetaData auth; Polygon endpoints must NOT be called
    const stubFetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url.includes("nexus-api.thetadata.us")) {
        return makeJsonResponse({ sessionId: "stub-session", user: { email: "stub@test.com" } });
      }
      // Polygon calls must not reach here; if they do, return 403 to surface the bug
      return makeJsonResponse({ error: "unexpected Polygon call when polygonApiKey is null" }, 403);
    };
    globalThis.fetch = stubFetch;

    try {
      // No polygonApiKey (third constructor arg omitted / null)
      const provider = new ThetaDataProvider("stub-td-key", 0, null);
      (provider as any).getOptionSnapshot = async (type: string) =>
        type === "GreeksAll" ? [PROVIDER_GREEK_ROW] : [];
      await (provider as any).initPromise.catch(() => {});

      const yahooMap = new Map([
        ["META", { price: 595, changePercent: 0.8, volume: 18_000_000, avgVolume: 20_000_000, marketCap: 1_500_000_000_000 }],
      ]);
      const quote: StockQuote | null = await (provider as any).enrichTicker("META", yahooMap, Date.now());

      assert.ok(quote !== null, "enrichTicker must return a non-null StockQuote");
      assert.equal(
        quote!.nextEarningsDate, null,
        "nextEarningsDate must be null when polygonApiKey is null"
      );
      assert.equal(
        quote!.earningsIvHistory, null,
        "earningsIvHistory must be null when polygonApiKey is null"
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
