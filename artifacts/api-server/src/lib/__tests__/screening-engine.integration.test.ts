/**
 * screening-engine.integration.test.ts
 *
 * End-to-end integration test: runs ScreeningEngine.runScreening() against the
 * full MOCK_STOCKS universe and asserts which symbols qualify.
 *
 * "Today" is pinned to 2026-08-12 (the date the mock earnings dates were
 * authored against) so these assertions remain hermetic regardless of when the
 * test suite runs.
 *
 * Expected results at FIXED_TODAY = 2026-08-12:
 *
 *   AAPL  → QUALIFIED  (all 6 filters pass; earnings 2026-08-26 = 14 d out)
 *   META  → QUALIFIED  (all 6 filters pass; earnings 2026-08-29 = 17 d out)
 *   AMD   → QUALIFIED  (all 6 filters pass; earnings 2026-08-28 = 16 d out)
 *
 *   NVDA  → not qualified  (F2/F5 fail — earnings 24 d out)
 *   MSFT  → not qualified  (F2/F5 fail — earnings 29 d out)
 *   TSLA  → not qualified  (F4 fails — only 3/4 IV cycles rose)
 *   AMZN  → not qualified  (F2/F5 fail — earnings only 2 d out)
 *   SPY   → not qualified  (F6 fails — ETF, no 30–60¢ OTM calendar structure)
 *   GOOGL → not qualified  (F6 fails — call-side calendar peak below zero)
 *   COIN  → not qualified  (F2/F3/F5 fail — earnings 20 d out, poor liquidity)
 *   XOM   → not qualified  (F1 fails — oil sector excluded)
 *   UNH   → not qualified  (F1 fails — healthcare sector excluded)
 *   AMGN  → not qualified  (F1 fails — biotech sector excluded)
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScreeningEngine, FILTER_RULES, type ScreeningResult } from "../screening-engine.js";
import { MOCK_STOCKS } from "../market-data.js";

// ---------------------------------------------------------------------------
// Fixed "today" — must match the date the mock earnings dates were written for.
// All Filter 2 / Filter 5 evaluations receive this date so results never vary
// with the real wall clock.
// ---------------------------------------------------------------------------
const FIXED_TODAY = new Date("2026-08-12T00:00:00");

// Run the full pipeline once; every test below reads from this shared result.
const engine  = new ScreeningEngine(FILTER_RULES);
const results = engine.runScreening(MOCK_STOCKS, FIXED_TODAY);

// Helper: look up a result by symbol
function resultFor(symbol: string) {
  const r = results.find((s) => s.symbol === symbol);
  assert.ok(r, `Expected result for ${symbol} to exist in runScreening output`);
  return r!;
}

// ---------------------------------------------------------------------------
// 1. Universe coverage
// ---------------------------------------------------------------------------

describe("Full pipeline — universe coverage", () => {
  it("returns exactly one result per stock in MOCK_STOCKS", () => {
    assert.equal(
      results.length,
      MOCK_STOCKS.length,
      `runScreening must return ${MOCK_STOCKS.length} results, one per stock`
    );
  });

  it("every result contains filterResults for all 6 active rules", () => {
    for (const r of results) {
      assert.equal(
        r.filterResults.length,
        FILTER_RULES.length,
        `${r.symbol} must have ${FILTER_RULES.length} filterResults (one per rule)`
      );
    }
  });

  it("every result's filterResults are ordered to match FILTER_RULES", () => {
    for (const r of results) {
      for (let i = 0; i < FILTER_RULES.length; i++) {
        assert.equal(
          r.filterResults[i].name,
          FILTER_RULES[i].name,
          `${r.symbol} filterResults[${i}].name must match FILTER_RULES[${i}].name`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Qualified symbols
// ---------------------------------------------------------------------------

describe("Full pipeline — qualified symbols", () => {
  const EXPECTED_QUALIFIED = ["AAPL", "META", "AMD"];
  const EXPECTED_NOT_QUALIFIED = [
    "NVDA", "MSFT", "TSLA", "AMZN", "SPY", "GOOGL", "COIN",
    "XOM", "UNH", "AMGN",
  ];

  it("exactly 3 stocks qualify (AAPL, META, AMD)", () => {
    const qualified = results.filter((r) => r.qualified).map((r) => r.symbol).sort();
    assert.deepEqual(
      qualified,
      [...EXPECTED_QUALIFIED].sort(),
      `Qualified symbols must be [${EXPECTED_QUALIFIED.join(", ")}]`
    );
  });

  for (const symbol of EXPECTED_QUALIFIED) {
    it(`${symbol} is qualified`, () => {
      const r = resultFor(symbol);
      assert.equal(r.qualified, true,  `${symbol}.qualified must be true`);
      assert.equal(r.status, "qualified", `${symbol}.status must be "qualified"`);
    });
  }

  for (const symbol of EXPECTED_NOT_QUALIFIED) {
    it(`${symbol} is not qualified`, () => {
      const r = resultFor(symbol);
      assert.equal(r.qualified, false, `${symbol}.qualified must be false`);
      assert.equal(r.status, "not_qualified", `${symbol}.status must be "not_qualified"`);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. filterScore consistency
// ---------------------------------------------------------------------------

describe("Full pipeline — filterScore consistency", () => {
  it("qualified stocks have filterScore = 100", () => {
    for (const r of results.filter((r) => r.qualified)) {
      assert.equal(
        r.filterScore,
        100,
        `${r.symbol} is qualified so filterScore must be 100 (got ${r.filterScore})`
      );
    }
  });

  it("stocks with at least one failure have filterScore < 100", () => {
    for (const r of results.filter((r) => !r.qualified)) {
      assert.ok(
        r.filterScore < 100,
        `${r.symbol} is not qualified so filterScore must be < 100 (got ${r.filterScore})`
      );
    }
  });

  it("filterScore equals the percentage of filters that passed (rounded)", () => {
    for (const r of results) {
      const passCount = r.filterResults.filter((f) => f.passed).length;
      const expected  = Math.round((passCount / FILTER_RULES.length) * 100);
      assert.equal(
        r.filterScore,
        expected,
        `${r.symbol}: filterScore must be ${expected} (${passCount}/${FILTER_RULES.length} passed), got ${r.filterScore}`
      );
    }
  });

  it("qualified flag is true iff all filters passed", () => {
    for (const r of results) {
      const allPassed = r.filterResults.every((f) => f.passed);
      assert.equal(
        r.qualified,
        allPassed,
        `${r.symbol}: qualified=${r.qualified} must match allPassed=${allPassed}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Per-stock filter reasoning — key pass/fail assertions
// ---------------------------------------------------------------------------

describe("Full pipeline — AAPL (all 6 filters pass)", () => {
  it("passes Filter 1 (tech sector — not excluded)", () => {
    assert.equal(resultFor("AAPL").filterResults[0].passed, true, "AAPL must pass Filter 1");
  });
  it("passes Filter 2 (earnings 14 d out — lower bound of window)", () => {
    assert.equal(resultFor("AAPL").filterResults[1].passed, true, "AAPL must pass Filter 2");
  });
  it("passes Filter 3 (weekly options, penny quotes, spread $0.17 < $0.30 limit)", () => {
    assert.equal(resultFor("AAPL").filterResults[2].passed, true, "AAPL must pass Filter 3");
  });
  it("passes Filter 4 (4/4 IV cycles rose)", () => {
    assert.equal(resultFor("AAPL").filterResults[3].passed, true, "AAPL must pass Filter 4");
  });
  it("passes Filter 5 (earnings 14 d out — re-confirmed)", () => {
    assert.equal(resultFor("AAPL").filterResults[4].passed, true, "AAPL must pass Filter 5");
  });
  it("passes Filter 6 (both calendar peaks above zero)", () => {
    assert.equal(resultFor("AAPL").filterResults[5].passed, true, "AAPL must pass Filter 6");
  });
});

describe("Full pipeline — META (all 6 filters pass)", () => {
  it("passes Filter 1 (tech sector — not excluded)", () => {
    assert.equal(resultFor("META").filterResults[0].passed, true, "META must pass Filter 1");
  });
  it("passes Filter 2 (earnings 17 d out — inside window)", () => {
    assert.equal(resultFor("META").filterResults[1].passed, true, "META must pass Filter 2");
  });
  it("passes Filter 3 (spread $0.31 ≤ $0.50 limit for $512 stock)", () => {
    assert.equal(resultFor("META").filterResults[2].passed, true, "META must pass Filter 3");
  });
  it("passes Filter 4 (4/4 IV cycles rose)", () => {
    assert.equal(resultFor("META").filterResults[3].passed, true, "META must pass Filter 4");
  });
  it("passes Filter 5 (earnings 17 d out — re-confirmed)", () => {
    assert.equal(resultFor("META").filterResults[4].passed, true, "META must pass Filter 5");
  });
  it("passes Filter 6 (call peak +$3.42, put peak +$2.91)", () => {
    assert.equal(resultFor("META").filterResults[5].passed, true, "META must pass Filter 6");
  });
});

describe("Full pipeline — AMD (all 6 filters pass)", () => {
  it("passes Filter 1 (tech sector — not excluded)", () => {
    assert.equal(resultFor("AMD").filterResults[0].passed, true, "AMD must pass Filter 1");
  });
  it("passes Filter 2 (earnings 16 d out — inside window)", () => {
    assert.equal(resultFor("AMD").filterResults[1].passed, true, "AMD must pass Filter 2");
  });
  it("passes Filter 3 (spread $0.22 < $0.30 limit for $168 stock)", () => {
    assert.equal(resultFor("AMD").filterResults[2].passed, true, "AMD must pass Filter 3");
  });
  it("passes Filter 4 (4/4 IV cycles rose)", () => {
    assert.equal(resultFor("AMD").filterResults[3].passed, true, "AMD must pass Filter 4");
  });
  it("passes Filter 5 (earnings 16 d out — re-confirmed)", () => {
    assert.equal(resultFor("AMD").filterResults[4].passed, true, "AMD must pass Filter 5");
  });
  it("passes Filter 6 (call peak +$2.31, put peak +$1.87)", () => {
    assert.equal(resultFor("AMD").filterResults[5].passed, true, "AMD must pass Filter 6");
  });
});

// ---------------------------------------------------------------------------
// 5. Key disqualification reasons for non-qualifying stocks
// ---------------------------------------------------------------------------

describe("Full pipeline — disqualification reasons", () => {
  it("NVDA fails Filter 2 (earnings 24 d out — too early)", () => {
    assert.equal(resultFor("NVDA").filterResults[1].passed, false,
      "NVDA must fail Filter 2 (earnings 24 d out)");
  });

  it("NVDA fails Filter 3 (spread $0.62 exceeds $0.50 limit for $875 stock)", () => {
    assert.equal(resultFor("NVDA").filterResults[2].passed, false,
      "NVDA must fail Filter 3 (spread too wide)");
  });

  it("NVDA fails Filter 5 (earnings re-check — still 24 d out)", () => {
    assert.equal(resultFor("NVDA").filterResults[4].passed, false,
      "NVDA must fail Filter 5 (earnings 24 d out)");
  });

  it("MSFT fails Filter 2 (earnings 29 d out — too early)", () => {
    assert.equal(resultFor("MSFT").filterResults[1].passed, false,
      "MSFT must fail Filter 2 (earnings 29 d out)");
  });

  it("MSFT fails Filter 5 (earnings re-check — still 29 d out)", () => {
    assert.equal(resultFor("MSFT").filterResults[4].passed, false,
      "MSFT must fail Filter 5 (earnings 29 d out)");
  });

  it("TSLA fails Filter 4 (only 3/4 IV cycles rose — one cycle IV dropped)", () => {
    assert.equal(resultFor("TSLA").filterResults[3].passed, false,
      "TSLA must fail Filter 4 (3/4 IV rise)");
  });

  it("TSLA passes Filter 1, 2, 3, 5 (only Filter 4 and nothing downstream blocks it)", () => {
    const r = resultFor("TSLA");
    assert.equal(r.filterResults[0].passed, true,  "TSLA must pass Filter 1");
    assert.equal(r.filterResults[1].passed, true,  "TSLA must pass Filter 2");
    assert.equal(r.filterResults[2].passed, true,  "TSLA must pass Filter 3");
    assert.equal(r.filterResults[4].passed, true,  "TSLA must pass Filter 5");
  });

  it("AMZN fails Filter 2 (earnings only 2 d out — below 14 d minimum)", () => {
    assert.equal(resultFor("AMZN").filterResults[1].passed, false,
      "AMZN must fail Filter 2 (earnings 2 d out)");
  });

  it("SPY Filter 2 fails (bypassed=false) — ETF has no earnings date, which is a genuine failure", () => {
    // Null earnings date → passed=false, bypassed=false. No earnings = can't verify the window.
    const f2 = resultFor("SPY").filterResults[1];
    assert.equal(f2.passed,   false, "SPY Filter 2 must fail (passed=false)");
    assert.equal(f2.bypassed, false, "SPY Filter 2 must not be bypassed — null date is a genuine failure");
  });

  it("SPY fails Filter 6 (ETF — no 30–60¢ OTM calendar structure)", () => {
    assert.equal(resultFor("SPY").filterResults[5].passed, false,
      "SPY must fail Filter 6 (no calendar data)");
  });

  it("SPY fails Filter 1 only on sector? No — ETF is allowed by Filter 1", () => {
    assert.equal(resultFor("SPY").filterResults[0].passed, true,
      "SPY must pass Filter 1 (ETF sector is not excluded)");
  });

  it("GOOGL fails Filter 6 (call-side calendar peak −$0.43 is below zero)", () => {
    assert.equal(resultFor("GOOGL").filterResults[5].passed, false,
      "GOOGL must fail Filter 6 (call peak below zero)");
  });

  it("GOOGL passes Filters 1–5 (only Filter 6 rejects it)", () => {
    const r = resultFor("GOOGL");
    for (let i = 0; i < 5; i++) {
      assert.equal(
        r.filterResults[i].passed,
        true,
        `GOOGL must pass Filter ${i + 1} — only Filter 6 should reject it`
      );
    }
  });

  it("COIN fails Filter 2 (earnings 20 d out — too early)", () => {
    assert.equal(resultFor("COIN").filterResults[1].passed, false,
      "COIN must fail Filter 2 (earnings 20 d out)");
  });

  it("COIN fails Filter 3 (no weekly options, no penny increments)", () => {
    assert.equal(resultFor("COIN").filterResults[2].passed, false,
      "COIN must fail Filter 3 (poor liquidity)");
  });

  it("XOM fails Filter 1 (oil sector — excluded)", () => {
    assert.equal(resultFor("XOM").filterResults[0].passed, false,
      "XOM must fail Filter 1 (oil sector)");
  });

  it("UNH fails Filter 1 (healthcare sector — excluded)", () => {
    assert.equal(resultFor("UNH").filterResults[0].passed, false,
      "UNH must fail Filter 1 (healthcare sector)");
  });

  it("AMGN fails Filter 1 (biotech sector — excluded)", () => {
    assert.equal(resultFor("AMGN").filterResults[0].passed, false,
      "AMGN must fail Filter 1 (biotech sector)");
  });
});

// ---------------------------------------------------------------------------
// 6. Passthrough display fields match the source StockQuote
//
// evaluateStock() must copy every display field from the input StockQuote
// unchanged. A bug that shadows or overwrites any of these fields would not
// be caught by the qualified/filterScore assertions above.
// ---------------------------------------------------------------------------

describe("Full pipeline — passthrough display fields match StockQuote source", () => {
  // Check every stock in MOCK_STOCKS so that both qualified and non-qualified
  // paths are covered.
  // Fields that must be copied verbatim from StockQuote → ScreeningResult.
  // Typed as the intersection of both interfaces' keys so TypeScript enforces
  // that every name actually exists on both types.
  type SharedDisplayKey = keyof ScreeningResult & keyof typeof MOCK_STOCKS[number];
  const DISPLAY_FIELDS: SharedDisplayKey[] = [
    "symbol",
    "company",
    "price",
    "dailyChangePercent",
    "volume",
    "avgVolume",
    "marketCap",
    "impliedVolatility",
    "optionsVolume",
    "openInterest",
  ];

  for (const stock of MOCK_STOCKS) {
    for (const field of DISPLAY_FIELDS) {
      it(`${stock.symbol}.${field} matches MOCK_STOCKS source`, () => {
        const r = resultFor(stock.symbol);
        assert.equal(
          r[field],
          stock[field],
          `${stock.symbol}.${field}: expected ${String(stock[field])}, got ${String(r[field])}`
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 7. No mutable-state contamination between stocks
// ---------------------------------------------------------------------------

describe("Full pipeline — no cross-stock state contamination", () => {
  it("running runScreening twice on MOCK_STOCKS produces identical results", () => {
    const results2 = engine.runScreening(MOCK_STOCKS, FIXED_TODAY);
    for (let i = 0; i < results.length; i++) {
      assert.equal(
        results2[i].qualified,
        results[i].qualified,
        `${results[i].symbol}: second run qualified=${results2[i].qualified} must equal first run ${results[i].qualified}`
      );
      assert.equal(
        results2[i].filterScore,
        results[i].filterScore,
        `${results[i].symbol}: second run filterScore must equal first run`
      );
    }
  });

  it("evaluating a single stock produces the same result as when part of the full run", () => {
    for (const symbol of ["AAPL", "META", "AMD", "GOOGL", "TSLA"]) {
      const stock = MOCK_STOCKS.find((s) => s.symbol === symbol)!;
      const standalone = engine.evaluateStock(stock, FIXED_TODAY);
      const fromRun    = resultFor(symbol);
      assert.equal(
        standalone.qualified,
        fromRun.qualified,
        `${symbol}: standalone.qualified must match full-run result`
      );
      assert.equal(
        standalone.filterScore,
        fromRun.filterScore,
        `${symbol}: standalone.filterScore must match full-run result`
      );
    }
  });
});
