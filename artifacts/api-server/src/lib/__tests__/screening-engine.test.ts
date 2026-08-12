/**
 * screening-engine.test.ts
 *
 * Unit tests for Filter 1 — Sector Exclusion through Filter 5 — Earnings Verified 2 Weeks Out.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FILTER_RULES, ScreeningEngine, getFilterDefinitions } from "../screening-engine.js";
import type { StockQuote } from "../market-data.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal StockQuote fixture with only the fields Filter 1 needs. */
function makeStock(symbol: string, sector: string): StockQuote {
  return {
    symbol,
    company: `${symbol} Corp`,
    price: 100,
    dailyChangePercent: 0,
    volume: 1_000_000,
    avgVolume: 1_000_000,
    marketCap: 1_000_000_000,
    impliedVolatility: 0.3,
    optionsVolume: 100_000,
    openInterest: 500_000,
    sector,
    nextEarningsDate: null,
    liquidityMetrics: null,
    earningsIvHistory: null,
  };
}

// Filter references
const filter1 = FILTER_RULES[0];
const filter2 = FILTER_RULES[1];
const filter3 = FILTER_RULES[2];
const filter4 = FILTER_RULES[3];
const filter5 = FILTER_RULES[4];
const filter6 = FILTER_RULES[5];

// ---------------------------------------------------------------------------
// Date helpers
//
// FIXED_TODAY is pinned to a specific calendar date so that every
// date-dependent test is fully hermetic — the result never changes as real
// time passes.  Pass FIXED_TODAY as the second argument to filter2.evaluate()
// and filter5.evaluate() wherever the test needs a deterministic "today".
//
// dateFromFixed(N) returns a YYYY-MM-DD string that is N calendar days away
// from FIXED_TODAY, letting tests express "14 days out" without hard-coding
// an absolute date that would need updating when the window constants change.
//
// IMPORTANT: we build the YYYY-MM-DD string from *local* date components
// (getFullYear / getMonth / getDate), not toISOString(), because toISOString()
// returns a UTC timestamp which shifts the calendar date by one day in time
// zones east of UTC (e.g. Asia/Kolkata).  The filter implementations also
// parse earnings dates as local midnight ("YYYY-MM-DDT00:00:00"), so both
// sides are consistent regardless of the host's time zone.
// ---------------------------------------------------------------------------
const FIXED_TODAY = new Date("2026-01-15T00:00:00");

function dateFromFixed(days: number): string {
  const d = new Date(FIXED_TODAY);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const dd   = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Shared base stock fixture — every filter test overrides only the fields it
// cares about, so fixtures stay minimal and readable.
// ---------------------------------------------------------------------------
function baseStock(overrides: Partial<StockQuote> = {}): StockQuote {
  return {
    symbol: "TEST",
    company: "Test Corp",
    price: 100,
    dailyChangePercent: 0,
    volume: 1_000_000,
    avgVolume: 1_000_000,
    marketCap: 1_000_000_000,
    impliedVolatility: 0.3,
    optionsVolume: 100_000,
    openInterest: 500_000,
    sector: "tech",
    nextEarningsDate: null,
    liquidityMetrics: null,
    earningsIvHistory: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Excluded sectors — must return passed: false
// ---------------------------------------------------------------------------

describe("Filter 1 — Sector Exclusion: excluded sectors return passed=false", () => {
  const excludedCases: { symbol: string; sector: string; expectedLabel: string }[] = [
    { symbol: "XOM",  sector: "oil",        expectedLabel: "Oil & Energy"     },
    { symbol: "UNH",  sector: "healthcare", expectedLabel: "Healthcare"        },
    { symbol: "AMGN", sector: "biotech",    expectedLabel: "Biotech"           },
    { symbol: "LMT",  sector: "defense",    expectedLabel: "Military Defense"  },
  ];

  for (const { symbol, sector, expectedLabel } of excludedCases) {
    it(`excludes ${symbol} (${sector})`, () => {
      const result = filter1.evaluate(makeStock(symbol, sector));

      assert.equal(
        result.passed,
        false,
        `${symbol} (${sector}) must be excluded (passed must be false)`
      );

      assert.equal(
        result.calculatedValue,
        expectedLabel,
        `calculatedValue for ${symbol} must be the human-readable label "${expectedLabel}"`
      );

      assert.ok(
        result.explanation.includes(symbol),
        `explanation for ${symbol} must mention the symbol (got: "${result.explanation}")`
      );

      assert.ok(
        result.explanation.includes(expectedLabel),
        `explanation for ${symbol} must mention the sector label "${expectedLabel}" (got: "${result.explanation}")`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Allowed sectors — must return passed: true
// ---------------------------------------------------------------------------

describe("Filter 1 — Sector Exclusion: allowed sectors return passed=true", () => {
  const allowedCases: { symbol: string; sector: string; expectedLabel: string }[] = [
    { symbol: "AAPL", sector: "tech",       expectedLabel: "Technology" },
    { symbol: "JPM",  sector: "finance",    expectedLabel: "Finance"    },
    { symbol: "WMT",  sector: "consumer",   expectedLabel: "Consumer"   },
    { symbol: "TSLA", sector: "automotive", expectedLabel: "Automotive" },
    { symbol: "SPY",  sector: "etf",        expectedLabel: "ETF"        },
  ];

  for (const { symbol, sector, expectedLabel } of allowedCases) {
    it(`allows ${symbol} (${sector})`, () => {
      const result = filter1.evaluate(makeStock(symbol, sector));

      assert.equal(
        result.passed,
        true,
        `${symbol} (${sector}) must be allowed (passed must be true)`
      );

      assert.equal(
        result.calculatedValue,
        expectedLabel,
        `calculatedValue for ${symbol} must be the human-readable label "${expectedLabel}"`
      );

      assert.ok(
        result.explanation.includes(symbol),
        `explanation for ${symbol} must mention the symbol (got: "${result.explanation}")`
      );

      assert.ok(
        result.explanation.includes(expectedLabel),
        `explanation for ${symbol} must mention the sector label "${expectedLabel}" (got: "${result.explanation}")`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Filter 1 — Sector Exclusion: edge cases", () => {
  it("treats unknown sector as 'Other' and allows it", () => {
    const result = filter1.evaluate(makeStock("UNKN", "unknown_sector_xyz"));

    assert.equal(
      result.passed,
      true,
      "unknown sector must not be excluded (passed must be true)"
    );

    // Falls back to the raw sector string when there is no label mapping
    assert.ok(
      result.calculatedValue.length > 0,
      "calculatedValue must not be empty for unknown sector"
    );
  });

  it("treats missing sector (undefined) as 'other' and allows it", () => {
    const stock = makeStock("NOSEC", "other");
    const result = filter1.evaluate(stock);

    assert.equal(
      result.passed,
      true,
      "sector='other' must not be excluded"
    );

    assert.equal(
      result.calculatedValue,
      "Other",
      "calculatedValue for sector='other' must be 'Other'"
    );
  });

  it("name property matches the filter name string", () => {
    const result = filter1.evaluate(makeStock("AAPL", "tech"));
    assert.ok(
      result.name.includes("Filter 1"),
      `result.name must include 'Filter 1' (got: "${result.name}")`
    );
  });

  it("threshold describes all four excluded sectors", () => {
    const result = filter1.evaluate(makeStock("AAPL", "tech"));
    const t = result.threshold.toLowerCase();
    assert.ok(t.includes("oil"),        `threshold must mention 'oil' (got: "${result.threshold}")`);
    assert.ok(t.includes("biotech"),    `threshold must mention 'biotech' (got: "${result.threshold}")`);
    assert.ok(t.includes("healthcare"), `threshold must mention 'healthcare' (got: "${result.threshold}")`);
    assert.ok(t.includes("defense"),    `threshold must mention 'defense' (got: "${result.threshold}")`);
  });
});

// ---------------------------------------------------------------------------
// getFilterDefinitions() — metadata returned to the Filters panel
// ---------------------------------------------------------------------------

describe("getFilterDefinitions()", () => {
  const defs = getFilterDefinitions();

  it("returns one definition per active FILTER_RULES entry", () => {
    assert.equal(
      defs.length,
      FILTER_RULES.length,
      `getFilterDefinitions() must return ${FILTER_RULES.length} entries, one per active rule`
    );
  });

  it("every definition has a non-empty name, description, and threshold", () => {
    for (const def of defs) {
      assert.ok(def.name.trim().length > 0,        `name must be non-empty (got: "${def.name}")`);
      assert.ok(def.description.trim().length > 0, `description must be non-empty for "${def.name}"`);
      assert.ok(def.threshold.trim().length > 0,   `threshold must be non-empty for "${def.name}"`);
    }
  });

  it("every definition has implemented=true (all rules are active)", () => {
    for (const def of defs) {
      assert.equal(
        def.implemented,
        true,
        `implemented must be true for "${def.name}"`
      );
    }
  });

  it("definition names match the corresponding FILTER_RULES names in order", () => {
    for (let i = 0; i < FILTER_RULES.length; i++) {
      assert.equal(
        defs[i].name,
        FILTER_RULES[i].name,
        `definition[${i}].name must match FILTER_RULES[${i}].name`
      );
    }
  });

  it("Filter 4 description references realized volatility (RV proxy), not raw implied volatility", () => {
    const filter4Def = defs.find((d) => d.name.includes("Filter 4"));
    assert.ok(filter4Def, "Filter 4 definition must exist");
    const desc = filter4Def!.description.toLowerCase();
    assert.ok(
      desc.includes("realized") || desc.includes("rv") || desc.includes("proxy"),
      `Filter 4 description must mention realized volatility or proxy usage (got: "${filter4Def!.description}")`
    );
  });
});

// ===========================================================================
// Filter 2 — Earnings in 2 Weeks (14–18 day window)
// ===========================================================================

describe("Filter 2 — Earnings in 2 Weeks: boundary cases", () => {
  it("passes when earnings are exactly 14 days out (lower bound)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromFixed(14) });
    const result = filter2.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, true, "14 days out must be inside the window");
  });

  it("passes when earnings are exactly 18 days out (upper bound)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromFixed(18) });
    const result = filter2.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, true, "18 days out must be inside the window");
  });

  it("fails when earnings are 13 days out (one day below lower bound — too close)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromFixed(13) });
    const result = filter2.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, false, "13 days out must be rejected — too close to enter");
  });

  it("fails when earnings are 19 days out (one day above upper bound — too early)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromFixed(19) });
    const result = filter2.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, false, "19 days out must be rejected — not yet in the entry window");
  });

  it("is bypassed (passed=false, bypassed=true) when nextEarningsDate is null — data provider has no earnings calendar", () => {
    // When the data provider cannot supply an earnings date (e.g. ThetaData), the filter
    // is bypassed — neither passed nor failed — so the stock surfaces as qualified_with_caveats.
    const stock = baseStock({ nextEarningsDate: null });
    const result = filter2.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed,   false, "null earnings date must not count as passed");
    assert.equal(result.bypassed, true,  "null earnings date must set bypassed=true");
    assert.ok(
      result.calculatedValue.toLowerCase().includes("no earnings"),
      `calculatedValue must indicate no date (got: "${result.calculatedValue}")`
    );
    assert.ok(
      result.explanation.toLowerCase().includes("bypass") ||
        result.explanation.toLowerCase().includes("unavailable"),
      `explanation must mention bypass or unavailability (got: "${result.explanation}")`
    );
  });

  it("fails when earnings date is in the past", () => {
    const stock = baseStock({ nextEarningsDate: dateFromFixed(-5) });
    const result = filter2.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, false, "past earnings date must not pass");
    assert.ok(
      result.calculatedValue.includes("ago"),
      `calculatedValue must indicate the date was in the past (got: "${result.calculatedValue}")`
    );
  });
});

describe("Filter 2 — Earnings in 2 Weeks: result shape", () => {
  it("result.name includes 'Filter 2'", () => {
    const result = filter2.evaluate(baseStock({ nextEarningsDate: dateFromFixed(16) }), FIXED_TODAY);
    assert.ok(result.name.includes("Filter 2"), `name must include 'Filter 2' (got: "${result.name}")`);
  });

  it("threshold string mentions the day bounds", () => {
    const result = filter2.evaluate(baseStock({ nextEarningsDate: dateFromFixed(16) }), FIXED_TODAY);
    assert.ok(
      result.threshold.includes("14") && result.threshold.includes("18"),
      `threshold must mention 14 and 18 (got: "${result.threshold}")`
    );
  });
});

// ===========================================================================
// Filter 3 — Options Liquidity
// ===========================================================================

describe("Filter 3 — Options Liquidity: sub-rule failures", () => {
  it("fails when hasWeeklyOptions is false", () => {
    const stock = baseStock({
      price: 100,
      liquidityMetrics: {
        hasWeeklyOptions: false,
        hasPennyIncrements: true,
        nearTermSpread: 0.05,
        nearTermDte: 11,
        nearTermIv: 0.3,
        shortCallStrike: null, shortPutStrike: null, callCalendarPeak: null, putCalendarPeak: null,
      },
    });
    const result = filter3.evaluate(stock);
    assert.equal(result.passed, false, "no weekly options → must fail");
    assert.ok(
      result.explanation.toLowerCase().includes("weekly"),
      `explanation must mention weekly options (got: "${result.explanation}")`
    );
  });

  it("fails when hasPennyIncrements is false", () => {
    const stock = baseStock({
      price: 100,
      liquidityMetrics: {
        hasWeeklyOptions: true,
        hasPennyIncrements: false,
        nearTermSpread: 0.05,
        nearTermDte: 11,
        nearTermIv: 0.3,
        shortCallStrike: null, shortPutStrike: null, callCalendarPeak: null, putCalendarPeak: null,
      },
    });
    const result = filter3.evaluate(stock);
    assert.equal(result.passed, false, "no penny increments → must fail");
    assert.ok(
      result.explanation.toLowerCase().includes("0.05") ||
        result.explanation.toLowerCase().includes("nickel") ||
        result.explanation.toLowerCase().includes("increment"),
      `explanation must mention the increment issue (got: "${result.explanation}")`
    );
  });

  it("fails when spread exceeds the $0.10 tier limit ($80 stock, spread $0.35)", () => {
    // For a stock priced below $100, max spread = $0.10
    const stock = baseStock({
      price: 80,
      liquidityMetrics: {
        hasWeeklyOptions: true,
        hasPennyIncrements: true,
        nearTermSpread: 0.35,
        nearTermDte: 11,
        nearTermIv: 0.3,
        shortCallStrike: null, shortPutStrike: null, callCalendarPeak: null, putCalendarPeak: null,
      },
    });
    const result = filter3.evaluate(stock);
    assert.equal(result.passed, false, "spread $0.35 on $80 stock exceeds $0.10 limit → must fail");
    assert.ok(
      result.explanation.includes("0.35") || result.explanation.includes("0.10"),
      `explanation must reference the spread or limit (got: "${result.explanation}")`
    );
  });

  it("passes when all sub-rules pass (weekly, penny, spread within limit)", () => {
    // $100 stock, spread $0.09 < $0.10 limit
    const stock = baseStock({
      price: 99,
      liquidityMetrics: {
        hasWeeklyOptions: true,
        hasPennyIncrements: true,
        nearTermSpread: 0.09,
        nearTermDte: 11,
        nearTermIv: 0.3,
        shortCallStrike: null, shortPutStrike: null, callCalendarPeak: null, putCalendarPeak: null,
      },
    });
    const result = filter3.evaluate(stock);
    assert.equal(result.passed, true, "all sub-rules pass → must pass");
  });

  it("fails when liquidityMetrics is null", () => {
    const stock = baseStock({ liquidityMetrics: null });
    const result = filter3.evaluate(stock);
    assert.equal(result.passed, false, "null liquidityMetrics → must fail");
    assert.ok(
      result.calculatedValue.toLowerCase().includes("no options") ||
        result.calculatedValue.toLowerCase().includes("no data"),
      `calculatedValue must indicate missing data (got: "${result.calculatedValue}")`
    );
  });
});

describe("Filter 3 — Options Liquidity: spread tier boundaries", () => {
  // Verify maxSpreadForPrice tiers using representative prices
  const tierCases: { price: number; spreadOk: number; spreadFail: number; limit: string }[] = [
    { price: 50,  spreadOk: 0.10, spreadFail: 0.11, limit: "$0.10 (sub-$100)" },
    { price: 150, spreadOk: 0.30, spreadFail: 0.31, limit: "$0.30 ($100–$250)" },
    { price: 300, spreadOk: 0.40, spreadFail: 0.41, limit: "$0.40 ($250–$500)" },
    { price: 600, spreadOk: 0.50, spreadFail: 0.51, limit: "$0.50 ($500+)" },
  ];

  for (const { price, spreadOk, spreadFail, limit } of tierCases) {
    it(`$${price} stock: spread $${spreadOk} passes, $${spreadFail} fails (limit ${limit})`, () => {
      const goodStock = baseStock({
        price,
        liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: spreadOk, nearTermDte: 11, nearTermIv: 0.3, shortCallStrike: null, shortPutStrike: null, callCalendarPeak: null, putCalendarPeak: null },
      });
      const badStock = baseStock({
        price,
        liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: spreadFail, nearTermDte: 11, nearTermIv: 0.3, shortCallStrike: null, shortPutStrike: null, callCalendarPeak: null, putCalendarPeak: null },
      });
      assert.equal(filter3.evaluate(goodStock).passed, true,  `spread $${spreadOk} on $${price} stock must pass`);
      assert.equal(filter3.evaluate(badStock).passed,  false, `spread $${spreadFail} on $${price} stock must fail`);
    });
  }
});

// ===========================================================================
// Filter 4 — IV Rise into Earnings (last 4 cycles)
// ===========================================================================

/** Builds a minimal EarningsIvRecord. Only ivRose matters for the filter logic. */
function ivRecord(ivRose: boolean, earningsDate = "2025-08-09"): import("../market-data.js").EarningsIvRecord {
  return { earningsDate, ivBaseline: 0.30, ivBeforeEarnings: ivRose ? 0.40 : 0.25, ivRose };
}

describe("Filter 4 — IV Rise into Earnings: core pass/fail logic", () => {
  it("passes when all 4 records show ivRose=true", () => {
    const stock = baseStock({
      earningsIvHistory: [
        ivRecord(true, "2025-08-09"),
        ivRecord(true, "2025-11-07"),
        ivRecord(true, "2026-02-06"),
        ivRecord(true, "2026-05-08"),
      ],
    });
    const result = filter4.evaluate(stock);
    assert.equal(result.passed, true, "4/4 ivRose=true must pass");
  });

  it("fails when only 3 of 4 records show ivRose=true", () => {
    const stock = baseStock({
      earningsIvHistory: [
        ivRecord(true,  "2025-08-09"),
        ivRecord(true,  "2025-11-07"),
        ivRecord(false, "2026-02-06"),
        ivRecord(true,  "2026-05-08"),
      ],
    });
    const result = filter4.evaluate(stock);
    assert.equal(result.passed, false, "3/4 ivRose=true must fail");
    assert.ok(
      result.calculatedValue.includes("3/4"),
      `calculatedValue must reflect 3/4 (got: "${result.calculatedValue}")`
    );
  });

  it("fails when fewer than 4 records are present (insufficient history)", () => {
    const stock = baseStock({
      earningsIvHistory: [
        ivRecord(true, "2025-08-09"),
        ivRecord(true, "2025-11-07"),
        ivRecord(true, "2026-02-06"),
        // only 3 records
      ],
    });
    const result = filter4.evaluate(stock);
    assert.equal(result.passed, false, "fewer than 4 records must fail");
    assert.ok(
      result.explanation.toLowerCase().includes("insufficient") ||
        result.explanation.toLowerCase().includes("need 4") ||
        result.explanation.toLowerCase().includes("need four"),
      `explanation must mention insufficient history (got: "${result.explanation}")`
    );
  });

  it("is bypassed (passed=false, bypassed=true) when earningsIvHistory is null — data provider has no historical IV", () => {
    // When the data provider cannot supply historical IV data (e.g. ThetaData), the filter
    // is bypassed — neither passed nor failed — so the stock surfaces as qualified_with_caveats.
    const stock = baseStock({ earningsIvHistory: null });
    const result = filter4.evaluate(stock);
    assert.equal(result.passed,   false, "null earningsIvHistory must not count as passed");
    assert.equal(result.bypassed, true,  "null earningsIvHistory must set bypassed=true");
    assert.ok(
      result.explanation.toLowerCase().includes("bypass") ||
        result.explanation.toLowerCase().includes("unavailable"),
      `explanation must mention bypass or unavailability (got: "${result.explanation}")`
    );
  });
});

describe("Filter 4 — IV Rise into Earnings: result shape", () => {
  it("result.name includes 'Filter 4'", () => {
    const stock = baseStock({
      earningsIvHistory: [
        ivRecord(true, "2025-08-09"),
        ivRecord(true, "2025-11-07"),
        ivRecord(true, "2026-02-06"),
        ivRecord(true, "2026-05-08"),
      ],
    });
    const result = filter4.evaluate(stock);
    assert.ok(result.name.includes("Filter 4"), `name must include 'Filter 4' (got: "${result.name}")`);
  });

  it("threshold string mentions 4/4 cycles", () => {
    const stock = baseStock({ earningsIvHistory: null });
    const result = filter4.evaluate(stock);
    assert.ok(
      result.threshold.includes("4/4"),
      `threshold must mention '4/4' (got: "${result.threshold}")`
    );
  });
});

// ===========================================================================
// Filter 5 — Earnings Verified 2 Weeks Out (final gate)
// ===========================================================================

describe("Filter 5 — Earnings Verified 2 Weeks Out: boundary cases", () => {
  it("passes when earnings are exactly 14 days out (lower bound)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromFixed(14) });
    const result = filter5.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, true, "14 days out must be confirmed as in-window");
  });

  it("passes when earnings are exactly 18 days out (upper bound)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromFixed(18) });
    const result = filter5.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, true, "18 days out must be confirmed as in-window");
  });

  it("fails when earnings are 13 days out (below lower bound — window has closed)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromFixed(13) });
    const result = filter5.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, false, "13 days out — window has closed → must fail");
  });

  it("fails when earnings are 19 days out (above upper bound — not yet in window)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromFixed(19) });
    const result = filter5.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, false, "19 days out — not yet in window → must fail");
  });

  it("is bypassed (passed=false, bypassed=true) when nextEarningsDate is null — data provider has no earnings calendar", () => {
    // When the data provider cannot supply an earnings date (e.g. ThetaData), the filter
    // is bypassed — matching Filter 2 behaviour.
    const stock = baseStock({ nextEarningsDate: null });
    const result = filter5.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed,   false, "null earnings date must not count as passed");
    assert.equal(result.bypassed, true,  "null earnings date must set bypassed=true");
    assert.ok(
      result.calculatedValue.toLowerCase().includes("no earnings") ||
        result.calculatedValue.toLowerCase().includes("no date") ||
        result.calculatedValue.toLowerCase().includes("no confirmed"),
      `calculatedValue must indicate missing date (got: "${result.calculatedValue}")`
    );
    assert.ok(
      result.explanation.toLowerCase().includes("bypass") ||
        result.explanation.toLowerCase().includes("unavailable"),
      `explanation must mention bypass or unavailability (got: "${result.explanation}")`
    );
  });

  it("fails when earnings date is in the past", () => {
    const stock = baseStock({ nextEarningsDate: dateFromFixed(-3) });
    const result = filter5.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, false, "past earnings date must not be verified as in-window");
    assert.ok(
      result.calculatedValue.includes("ago"),
      `calculatedValue must indicate the date was in the past (got: "${result.calculatedValue}")`
    );
  });
});

describe("Filter 5 — Earnings Verified 2 Weeks Out: independent re-verification", () => {
  it("uses the same 14–18 day window as Filter 2 (shares EARNINGS_WINDOW constants)", () => {
    // Both filters must agree on a date that is exactly on the boundary.
    // Use the same FIXED_TODAY for both so the comparison is deterministic.
    const onBoundary14 = baseStock({ nextEarningsDate: dateFromFixed(14) });
    const onBoundary18 = baseStock({ nextEarningsDate: dateFromFixed(18) });
    const justOutside13 = baseStock({ nextEarningsDate: dateFromFixed(13) });
    const justOutside19 = baseStock({ nextEarningsDate: dateFromFixed(19) });

    // Filter 5 must independently agree with Filter 2 on every boundary
    assert.equal(filter5.evaluate(onBoundary14, FIXED_TODAY).passed, filter2.evaluate(onBoundary14, FIXED_TODAY).passed, "F5 and F2 must agree at 14d");
    assert.equal(filter5.evaluate(onBoundary18, FIXED_TODAY).passed, filter2.evaluate(onBoundary18, FIXED_TODAY).passed, "F5 and F2 must agree at 18d");
    assert.equal(filter5.evaluate(justOutside13, FIXED_TODAY).passed, filter2.evaluate(justOutside13, FIXED_TODAY).passed, "F5 and F2 must agree at 13d");
    assert.equal(filter5.evaluate(justOutside19, FIXED_TODAY).passed, filter2.evaluate(justOutside19, FIXED_TODAY).passed, "F5 and F2 must agree at 19d");
  });

  it("result.name includes 'Filter 5'", () => {
    const result = filter5.evaluate(baseStock({ nextEarningsDate: dateFromFixed(16) }), FIXED_TODAY);
    assert.ok(result.name.includes("Filter 5"), `name must include 'Filter 5' (got: "${result.name}")`);
  });

  it("passing result explanation confirms the symbol and days remaining", () => {
    const stock = baseStock({ symbol: "ACME", nextEarningsDate: dateFromFixed(16) });
    const result = filter5.evaluate(stock, FIXED_TODAY);
    assert.equal(result.passed, true);
    assert.ok(
      result.explanation.includes("ACME"),
      `explanation must mention the symbol (got: "${result.explanation}")`
    );
    assert.ok(
      result.explanation.includes("16"),
      `explanation must mention the days count (got: "${result.explanation}")`
    );
  });
});

// ===========================================================================
// Filter 6 — Double Calendar Structure
// ===========================================================================

/** Builds a full liquidityMetrics fixture for Filter 6 tests. */
function calendarMetrics(overrides: {
  shortCallStrike?: number | null;
  shortPutStrike?: number | null;
  callCalendarPeak?: number | null;
  putCalendarPeak?: number | null;
}): import("../market-data.js").OptionsLiquidityMetrics {
  return {
    hasWeeklyOptions: true,
    hasPennyIncrements: true,
    nearTermSpread: 0.15,
    nearTermDte: 11,
    nearTermIv: 0.35,
    shortCallStrike: overrides.shortCallStrike !== undefined ? overrides.shortCallStrike : 110,
    shortPutStrike:  overrides.shortPutStrike  !== undefined ? overrides.shortPutStrike  : 90,
    callCalendarPeak: overrides.callCalendarPeak !== undefined ? overrides.callCalendarPeak : 1.50,
    putCalendarPeak:  overrides.putCalendarPeak  !== undefined ? overrides.putCalendarPeak  : 1.20,
  };
}

describe("Filter 6 — Double Calendar Structure: positive cases", () => {
  it("passes when both callCalendarPeak and putCalendarPeak are above zero", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 1.50, putCalendarPeak: 1.20 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, true, "both peaks > 0 must pass");
  });

  it("passes with large positive peaks matching META mock values (+$3.42 / +$2.91)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({
        shortCallStrike: 560.0,
        shortPutStrike: 467.5,
        callCalendarPeak: 3.42,
        putCalendarPeak: 2.91,
      }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, true, "large positive peaks must pass");
    // calculatedValue must format both peaks with sign prefix and dollar sign
    assert.ok(
      result.calculatedValue.includes("+$3.42"),
      `calculatedValue must include '+$3.42' (got: "${result.calculatedValue}")`
    );
    assert.ok(
      result.calculatedValue.includes("+$2.91"),
      `calculatedValue must include '+$2.91' (got: "${result.calculatedValue}")`
    );
  });

  it("result.name includes 'Filter 6'", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 0.50, putCalendarPeak: 0.50 }),
    });
    const result = filter6.evaluate(stock);
    assert.ok(result.name.includes("Filter 6"), `name must include 'Filter 6' (got: "${result.name}")`);
  });

  it("threshold string mentions both peaks and zero", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 1.00, putCalendarPeak: 1.00 }),
    });
    const result = filter6.evaluate(stock);
    const t = result.threshold.toLowerCase();
    assert.ok(
      t.includes("peak") || t.includes(">") || t.includes("$0"),
      `threshold must reference peaks and zero line (got: "${result.threshold}")`
    );
  });

  it("passes with minimum viable positive peaks ($0.01 call / $0.01 put) — boundary just above zero", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 0.01, putCalendarPeak: 0.01 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      true,
      "callCalendarPeak=$0.01 and putCalendarPeak=$0.01 are both strictly above zero — must pass"
    );
  });

  it("fails when put peak is exactly $0.00 with call peak at $0.01 (put side on the zero line)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 0.01, putCalendarPeak: 0.00 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "putCalendarPeak=$0.00 is not strictly above zero — must fail even when callCalendarPeak=$0.01"
    );
    assert.ok(
      result.explanation.toLowerCase().includes("put"),
      `explanation must identify the put side as the failing leg (got: "${result.explanation}")`
    );
  });

  it("passing result: calculatedValue and explanation both reference strike prices and peak values", () => {
    // Use explicit strikes and peaks so assertions are unambiguous
    const stock = baseStock({
      symbol: "ACME",
      liquidityMetrics: calendarMetrics({
        shortCallStrike: 110,
        shortPutStrike: 90,
        callCalendarPeak: 1.50,
        putCalendarPeak: 1.20,
      }),
    });
    const result = filter6.evaluate(stock);

    assert.equal(result.passed, true, "both peaks > 0 must pass");

    // calculatedValue must include formatted peak values for both legs
    assert.ok(
      result.calculatedValue.includes("+$1.50"),
      `calculatedValue must include '+$1.50' call peak (got: "${result.calculatedValue}")`
    );
    assert.ok(
      result.calculatedValue.includes("+$1.20"),
      `calculatedValue must include '+$1.20' put peak (got: "${result.calculatedValue}")`
    );

    // explanation must reference the call strike
    assert.ok(
      result.explanation.includes("110"),
      `explanation must mention call strike 110 (got: "${result.explanation}")`
    );
    // explanation must reference the put strike
    assert.ok(
      result.explanation.includes("90"),
      `explanation must mention put strike 90 (got: "${result.explanation}")`
    );
    // explanation must reference the call peak value
    assert.ok(
      result.explanation.includes("1.50"),
      `explanation must mention call peak 1.50 (got: "${result.explanation}")`
    );
    // explanation must reference the put peak value
    assert.ok(
      result.explanation.includes("1.20"),
      `explanation must mention put peak 1.20 (got: "${result.explanation}")`
    );
    // explanation must confirm viability
    assert.ok(
      result.explanation.toLowerCase().includes("viable") ||
        result.explanation.toLowerCase().includes("above zero"),
      `explanation must confirm the structure is viable (got: "${result.explanation}")`
    );
  });
});

describe("Filter 6 — Double Calendar Structure: negative cases", () => {
  it("fails when callCalendarPeak is exactly zero (at the zero line — not above)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 0, putCalendarPeak: 1.20 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "callCalendarPeak = 0 must fail — must be strictly above zero");
    assert.ok(
      result.explanation.toLowerCase().includes("call"),
      `explanation must name the call side (got: "${result.explanation}")`
    );
  });

  it("fails when callCalendarPeak is $0.00 with putCalendarPeak at $0.01 (call side on the zero line)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 0.00, putCalendarPeak: 0.01 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "callCalendarPeak=$0.00 is not strictly above zero — must fail even when putCalendarPeak=$0.01"
    );
    assert.ok(
      result.explanation.toLowerCase().includes("call"),
      `explanation must identify the call side as the failing leg (got: "${result.explanation}")`
    );
  });

  it("fails when callCalendarPeak is negative (call-side peak below zero line)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: -0.43, putCalendarPeak: 1.18 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "negative callCalendarPeak must fail");
    assert.ok(
      result.explanation.toLowerCase().includes("call"),
      `explanation must name the call side (got: "${result.explanation}")`
    );
  });

  it("fails when putCalendarPeak is exactly zero (at the zero line — not above)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 1.50, putCalendarPeak: 0 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "putCalendarPeak = 0 must fail — must be strictly above zero");
    assert.ok(
      result.explanation.toLowerCase().includes("put"),
      `explanation must name the put side (got: "${result.explanation}")`
    );
  });

  it("fails when putCalendarPeak is negative (put-side peak below zero line)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 1.50, putCalendarPeak: -0.25 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "negative putCalendarPeak must fail");
    assert.ok(
      result.explanation.toLowerCase().includes("put"),
      `explanation must name the put side (got: "${result.explanation}")`
    );
  });

  it("fails when both peaks are at or below zero — explanation mentions both sides", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: -0.30, putCalendarPeak: -0.15 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "both peaks ≤ 0 must fail");
    const exp = result.explanation.toLowerCase();
    assert.ok(
      exp.includes("both"),
      `explanation must mention 'both' when both peaks are below zero (got: "${result.explanation}")`
    );
  });

  it("fails when both peaks are exactly zero — explanation mentions both sides", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 0, putCalendarPeak: 0 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "both peaks = 0 must fail");
    const exp = result.explanation.toLowerCase();
    assert.ok(
      exp.includes("both"),
      `explanation must mention 'both' when both peaks are at zero (got: "${result.explanation}")`
    );
  });

  it("fails with 'No calendar data' when liquidityMetrics is null", () => {
    const stock = baseStock({ liquidityMetrics: null });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "null liquidityMetrics must fail");
    assert.equal(
      result.calculatedValue,
      "No calendar data",
      `calculatedValue must be 'No calendar data' (got: "${result.calculatedValue}")`
    );
  });

  it("fails with 'No calendar data' when shortCallStrike is null (no 30–60¢ call strike found)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({
        shortCallStrike: null,
        callCalendarPeak: 1.50,
        putCalendarPeak: 1.20,
      }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "null shortCallStrike must fail — no viable call leg");
    assert.equal(
      result.calculatedValue,
      "No calendar data",
      `calculatedValue must be 'No calendar data' (got: "${result.calculatedValue}")`
    );
  });

  it("fails with 'No calendar data' when shortPutStrike is null (no 30–60¢ put strike found)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({
        shortPutStrike: null,
        callCalendarPeak: 1.50,
        putCalendarPeak: 1.20,
      }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "null shortPutStrike must fail — no viable put leg");
    assert.equal(
      result.calculatedValue,
      "No calendar data",
      `calculatedValue must be 'No calendar data' (got: "${result.calculatedValue}")`
    );
  });

  it("fails gracefully when callCalendarPeak is null (long-chain contract missing)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({
        callCalendarPeak: null,
        putCalendarPeak: 1.20,
      }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "null callCalendarPeak must fail gracefully");
    assert.equal(
      result.calculatedValue,
      "No calendar data",
      `calculatedValue must be 'No calendar data' when callCalendarPeak is null (got: "${result.calculatedValue}")`
    );
  });

  it("fails gracefully when putCalendarPeak is null (long-chain contract missing)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({
        callCalendarPeak: 1.50,
        putCalendarPeak: null,
      }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(result.passed, false, "null putCalendarPeak must fail gracefully");
    assert.equal(
      result.calculatedValue,
      "No calendar data",
      `calculatedValue must be 'No calendar data' when putCalendarPeak is null (got: "${result.calculatedValue}")`
    );
  });

  // ---------------------------------------------------------------------------
  // Asymmetric null cases — one leg is a large positive value, the other null.
  // Confirms the filter never treats a missing leg as zero (a silent pass on
  // the zero boundary) and always requires *both* legs to be present and positive.
  // ---------------------------------------------------------------------------

  it("fails with 'No calendar data' when callCalendarPeak=null and putCalendarPeak=+$5.00 (asymmetric null — call leg missing)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({
        callCalendarPeak: null,
        putCalendarPeak: 5.00,
      }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "callCalendarPeak=null must cause rejection even when putCalendarPeak=+$5.00 — missing leg must never be treated as zero"
    );
    assert.equal(
      result.calculatedValue,
      "No calendar data",
      `calculatedValue must be 'No calendar data' when callCalendarPeak is null (got: "${result.calculatedValue}")`
    );
  });

  it("fails with 'No calendar data' when callCalendarPeak=+$5.00 and putCalendarPeak=null (asymmetric null — put leg missing)", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({
        callCalendarPeak: 5.00,
        putCalendarPeak: null,
      }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "putCalendarPeak=null must cause rejection even when callCalendarPeak=+$5.00 — missing leg must never be treated as zero"
    );
    assert.equal(
      result.calculatedValue,
      "No calendar data",
      `calculatedValue must be 'No calendar data' when putCalendarPeak is null (got: "${result.calculatedValue}")`
    );
  });

  it("fails when callCalendarPeak=$0.00 and putCalendarPeak=$5.00 — call side alone drives the rejection", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 0.00, putCalendarPeak: 5.00 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "callCalendarPeak=$0.00 must cause rejection regardless of a large putCalendarPeak ($5.00)"
    );
    assert.ok(
      result.explanation.toLowerCase().includes("call"),
      `explanation must name the call side as the failing leg (got: "${result.explanation}")`
    );
  });

  it("fails when callCalendarPeak=$5.00 and putCalendarPeak=$0.00 — put side alone drives the rejection", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 5.00, putCalendarPeak: 0.00 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "putCalendarPeak=$0.00 must cause rejection regardless of a large callCalendarPeak ($5.00)"
    );
    assert.ok(
      result.explanation.toLowerCase().includes("put"),
      `explanation must name the put side as the failing leg (got: "${result.explanation}")`
    );
  });

  it("fails when callCalendarPeak=-$1.50 and putCalendarPeak=+$5.00 — deeply negative call rejects despite large put profit", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: -1.50, putCalendarPeak: 5.00 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "callCalendarPeak=-$1.50 must cause rejection even when putCalendarPeak=+$5.00 is large and profitable"
    );
    assert.ok(
      result.explanation.toLowerCase().includes("call"),
      `explanation must name the call side as the failing leg (got: "${result.explanation}")`
    );
  });

  it("fails when callCalendarPeak=+$5.00 and putCalendarPeak=-$1.50 — deeply negative put rejects despite large call profit", () => {
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({ callCalendarPeak: 5.00, putCalendarPeak: -1.50 }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "putCalendarPeak=-$1.50 must cause rejection even when callCalendarPeak=+$5.00 is large and profitable"
    );
    assert.ok(
      result.explanation.toLowerCase().includes("put"),
      `explanation must name the put side as the failing leg (got: "${result.explanation}")`
    );
  });

  it("fails with 'No calendar data' when both shortCallStrike and shortPutStrike are null but peaks are both +$5.00", () => {
    // Both strike fields are absent, confirming the strike-null guard cannot be
    // bypassed by the presence of large positive peak values.
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({
        shortCallStrike: null,
        shortPutStrike: null,
        callCalendarPeak: 5.00,
        putCalendarPeak: 5.00,
      }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "shortCallStrike=null and shortPutStrike=null must cause rejection even when both peaks are +$5.00"
    );
    assert.equal(
      result.calculatedValue,
      "No calendar data",
      `calculatedValue must be 'No calendar data' when both strike fields are null (got: "${result.calculatedValue}")`
    );
  });

  it("fails with 'No calendar data' when all four calendar fields are null (shortCallStrike=null, shortPutStrike=null, callCalendarPeak=null, putCalendarPeak=null)", () => {
    // Total absence of all calendar data — no strikes and no peak values.
    // This is the remaining untested null combination: confirms the null-guard
    // handles complete data absence rather than only partial absence.
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({
        shortCallStrike: null,
        shortPutStrike: null,
        callCalendarPeak: null,
        putCalendarPeak: null,
      }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "all four calendar fields null must cause rejection — total absence of calendar data"
    );
    assert.equal(
      result.calculatedValue,
      "No calendar data",
      `calculatedValue must be 'No calendar data' when all four calendar fields are null (got: "${result.calculatedValue}")`
    );
  });

  it("fails with 'No calendar data' when strikes are present but both peaks are null (shortCallStrike=110, shortPutStrike=90, callCalendarPeak=null, putCalendarPeak=null)", () => {
    // Strikes found but no peak data at all — confirms the peak-null guard
    // works independently from the strike-null guard. This is the final
    // untested partial null combination: strikes present, peaks absent.
    const stock = baseStock({
      liquidityMetrics: calendarMetrics({
        shortCallStrike: 110,
        shortPutStrike: 90,
        callCalendarPeak: null,
        putCalendarPeak: null,
      }),
    });
    const result = filter6.evaluate(stock);
    assert.equal(
      result.passed,
      false,
      "callCalendarPeak=null and putCalendarPeak=null must cause rejection even when strikes are present (110/90)"
    );
    assert.equal(
      result.calculatedValue,
      "No calendar data",
      `calculatedValue must be 'No calendar data' when both peaks are null (got: "${result.calculatedValue}")`
    );
  });
});

// ===========================================================================
// ScreeningEngine — end-to-end integration: all 6 filters
// ===========================================================================

/**
 * A stock fixture that satisfies every filter requirement:
 *
 *   Filter 1 — sector "tech" is not excluded
 *   Filter 2 — earnings 16 days out (inside the 14–18 day window)
 *   Filter 3 — weekly options, penny increments, spread $0.09 < $0.10 limit (price $99)
 *   Filter 4 — 4/4 IV cycles show ivRose=true
 *   Filter 5 — same earnings date as Filter 2 — re-confirmed in window
 *   Filter 6 — callCalendarPeak $1.50 > 0, putCalendarPeak $1.20 > 0
 */
function fullyQualifiedStock(): StockQuote {
  return {
    symbol: "QUAL",
    company: "Qualified Corp",
    price: 99,
    dailyChangePercent: 0.5,
    volume: 2_000_000,
    avgVolume: 1_500_000,
    marketCap: 10_000_000_000,
    impliedVolatility: 0.35,
    optionsVolume: 200_000,
    openInterest: 800_000,
    sector: "tech",
    nextEarningsDate: dateFromFixed(16),
    liquidityMetrics: {
      hasWeeklyOptions: true,
      hasPennyIncrements: true,
      nearTermSpread: 0.09,
      nearTermDte: 11,
      nearTermIv: 0.35,
      shortCallStrike: 105,
      shortPutStrike: 93,
      callCalendarPeak: 1.50,
      putCalendarPeak: 1.20,
    },
    earningsIvHistory: [
      { earningsDate: "2025-08-09", ivBaseline: 0.28, ivBeforeEarnings: 0.41, ivRose: true },
      { earningsDate: "2025-11-07", ivBaseline: 0.30, ivBeforeEarnings: 0.45, ivRose: true },
      { earningsDate: "2026-02-06", ivBaseline: 0.27, ivBeforeEarnings: 0.39, ivRose: true },
      { earningsDate: "2026-05-08", ivBaseline: 0.31, ivBeforeEarnings: 0.46, ivRose: true },
    ],
  };
}

describe("ScreeningEngine — end-to-end: fully-qualified stock passes all 6 filters", () => {
  const engine = new ScreeningEngine(FILTER_RULES);

  it("qualified is true", () => {
    const result = engine.evaluateStock(fullyQualifiedStock(), FIXED_TODAY);
    assert.equal(result.qualified, true, "a stock satisfying all filters must have qualified=true");
  });

  it("status is 'qualified'", () => {
    const result = engine.evaluateStock(fullyQualifiedStock(), FIXED_TODAY);
    assert.equal(result.status, "qualified", "status must be 'qualified'");
  });

  it("filterScore is 100", () => {
    const result = engine.evaluateStock(fullyQualifiedStock(), FIXED_TODAY);
    assert.equal(result.filterScore, 100, "filterScore must be 100 when all filters pass");
  });

  it("filterResults has exactly 6 entries — one per active rule", () => {
    const result = engine.evaluateStock(fullyQualifiedStock(), FIXED_TODAY);
    assert.equal(
      result.filterResults.length,
      FILTER_RULES.length,
      `filterResults must have ${FILTER_RULES.length} entries (got ${result.filterResults.length})`
    );
  });

  it("every filterResult has passed=true", () => {
    const result = engine.evaluateStock(fullyQualifiedStock(), FIXED_TODAY);
    for (const fr of result.filterResults) {
      assert.equal(
        fr.passed,
        true,
        `filterResult "${fr.name}" must have passed=true (got false — explanation: "${fr.explanation}")`
      );
    }
  });

  it("filterResults are in the same order as FILTER_RULES", () => {
    const result = engine.evaluateStock(fullyQualifiedStock(), FIXED_TODAY);
    for (let i = 0; i < FILTER_RULES.length; i++) {
      assert.equal(
        result.filterResults[i].name,
        FILTER_RULES[i].name,
        `filterResults[${i}].name must match FILTER_RULES[${i}].name`
      );
    }
  });

  it("result carries through the stock's display fields unchanged", () => {
    const stock = fullyQualifiedStock();
    const result = engine.evaluateStock(stock, FIXED_TODAY);
    assert.equal(result.symbol,           stock.symbol);
    assert.equal(result.company,          stock.company);
    assert.equal(result.price,            stock.price);
    assert.equal(result.dailyChangePercent, stock.dailyChangePercent);
    assert.equal(result.volume,           stock.volume);
    assert.equal(result.avgVolume,        stock.avgVolume);
    assert.equal(result.marketCap,        stock.marketCap);
    assert.equal(result.impliedVolatility, stock.impliedVolatility);
    assert.equal(result.optionsVolume,    stock.optionsVolume);
    assert.equal(result.openInterest,     stock.openInterest);
  });
});

describe("ScreeningEngine — end-to-end: flipping one field causes disqualification", () => {
  const engine = new ScreeningEngine(FILTER_RULES);

  it("setting callCalendarPeak=0 causes qualified=false (Filter 6 rejects)", () => {
    const stock = fullyQualifiedStock();
    stock.liquidityMetrics!.callCalendarPeak = 0;
    const result = engine.evaluateStock(stock, FIXED_TODAY);
    assert.equal(result.qualified, false, "callCalendarPeak=0 must cause qualified=false");
    assert.equal(result.status, "not_qualified", "status must be 'not_qualified'");
    assert.ok(result.filterScore < 100, `filterScore must be below 100 (got ${result.filterScore})`);
    const f6 = result.filterResults.find((r) => r.name.includes("Filter 6"));
    assert.ok(f6, "Filter 6 result must exist");
    assert.equal(f6!.passed, false, "Filter 6 must be the one that failed");
  });
});
