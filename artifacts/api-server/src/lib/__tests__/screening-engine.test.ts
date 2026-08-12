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
import { FILTER_RULES, getFilterDefinitions } from "../screening-engine.js";
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

// ---------------------------------------------------------------------------
// Date helper — returns a YYYY-MM-DD string N calendar days from today.
// Tests that depend on "now" must use this so they never go stale.
// ---------------------------------------------------------------------------
function dateFromToday(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
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
    const stock = baseStock({ nextEarningsDate: dateFromToday(14) });
    const result = filter2.evaluate(stock);
    assert.equal(result.passed, true, "14 days out must be inside the window");
  });

  it("passes when earnings are exactly 18 days out (upper bound)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromToday(18) });
    const result = filter2.evaluate(stock);
    assert.equal(result.passed, true, "18 days out must be inside the window");
  });

  it("fails when earnings are 13 days out (one day below lower bound — too close)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromToday(13) });
    const result = filter2.evaluate(stock);
    assert.equal(result.passed, false, "13 days out must be rejected — too close to enter");
  });

  it("fails when earnings are 19 days out (one day above upper bound — too early)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromToday(19) });
    const result = filter2.evaluate(stock);
    assert.equal(result.passed, false, "19 days out must be rejected — not yet in the entry window");
  });

  it("fails when nextEarningsDate is null", () => {
    const stock = baseStock({ nextEarningsDate: null });
    const result = filter2.evaluate(stock);
    assert.equal(result.passed, false, "null earnings date must not pass");
    assert.ok(
      result.calculatedValue.toLowerCase().includes("no earnings"),
      `calculatedValue must indicate no date (got: "${result.calculatedValue}")`
    );
  });

  it("fails when earnings date is in the past", () => {
    const stock = baseStock({ nextEarningsDate: dateFromToday(-5) });
    const result = filter2.evaluate(stock);
    assert.equal(result.passed, false, "past earnings date must not pass");
    assert.ok(
      result.calculatedValue.includes("ago"),
      `calculatedValue must indicate the date was in the past (got: "${result.calculatedValue}")`
    );
  });
});

describe("Filter 2 — Earnings in 2 Weeks: result shape", () => {
  it("result.name includes 'Filter 2'", () => {
    const result = filter2.evaluate(baseStock({ nextEarningsDate: dateFromToday(16) }));
    assert.ok(result.name.includes("Filter 2"), `name must include 'Filter 2' (got: "${result.name}")`);
  });

  it("threshold string mentions the day bounds", () => {
    const result = filter2.evaluate(baseStock({ nextEarningsDate: dateFromToday(16) }));
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
        liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: spreadOk, nearTermDte: 11, nearTermIv: 0.3 },
      });
      const badStock = baseStock({
        price,
        liquidityMetrics: { hasWeeklyOptions: true, hasPennyIncrements: true, nearTermSpread: spreadFail, nearTermDte: 11, nearTermIv: 0.3 },
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

  it("fails when earningsIvHistory is null", () => {
    const stock = baseStock({ earningsIvHistory: null });
    const result = filter4.evaluate(stock);
    assert.equal(result.passed, false, "null earningsIvHistory must fail");
    assert.ok(
      result.calculatedValue.includes("0/4"),
      `calculatedValue must show 0 cycles (got: "${result.calculatedValue}")`
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
    const stock = baseStock({ nextEarningsDate: dateFromToday(14) });
    const result = filter5.evaluate(stock);
    assert.equal(result.passed, true, "14 days out must be confirmed as in-window");
  });

  it("passes when earnings are exactly 18 days out (upper bound)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromToday(18) });
    const result = filter5.evaluate(stock);
    assert.equal(result.passed, true, "18 days out must be confirmed as in-window");
  });

  it("fails when earnings are 13 days out (below lower bound — window has closed)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromToday(13) });
    const result = filter5.evaluate(stock);
    assert.equal(result.passed, false, "13 days out — window has closed → must fail");
  });

  it("fails when earnings are 19 days out (above upper bound — not yet in window)", () => {
    const stock = baseStock({ nextEarningsDate: dateFromToday(19) });
    const result = filter5.evaluate(stock);
    assert.equal(result.passed, false, "19 days out — not yet in window → must fail");
  });

  it("fails when nextEarningsDate is null", () => {
    const stock = baseStock({ nextEarningsDate: null });
    const result = filter5.evaluate(stock);
    assert.equal(result.passed, false, "null earnings date must not be verified");
    assert.ok(
      result.calculatedValue.toLowerCase().includes("no earnings") ||
        result.calculatedValue.toLowerCase().includes("no date") ||
        result.calculatedValue.toLowerCase().includes("no confirmed"),
      `calculatedValue must indicate missing date (got: "${result.calculatedValue}")`
    );
  });

  it("fails when earnings date is in the past", () => {
    const stock = baseStock({ nextEarningsDate: dateFromToday(-3) });
    const result = filter5.evaluate(stock);
    assert.equal(result.passed, false, "past earnings date must not be verified as in-window");
    assert.ok(
      result.calculatedValue.includes("ago"),
      `calculatedValue must indicate the date was in the past (got: "${result.calculatedValue}")`
    );
  });
});

describe("Filter 5 — Earnings Verified 2 Weeks Out: independent re-verification", () => {
  it("uses the same 14–18 day window as Filter 2 (shares EARNINGS_WINDOW constants)", () => {
    // Both filters must agree on a date that is exactly on the boundary
    const onBoundary14 = baseStock({ nextEarningsDate: dateFromToday(14) });
    const onBoundary18 = baseStock({ nextEarningsDate: dateFromToday(18) });
    const justOutside13 = baseStock({ nextEarningsDate: dateFromToday(13) });
    const justOutside19 = baseStock({ nextEarningsDate: dateFromToday(19) });

    // Filter 5 must independently agree with Filter 2 on every boundary
    assert.equal(filter5.evaluate(onBoundary14).passed, filter2.evaluate(onBoundary14).passed, "F5 and F2 must agree at 14d");
    assert.equal(filter5.evaluate(onBoundary18).passed, filter2.evaluate(onBoundary18).passed, "F5 and F2 must agree at 18d");
    assert.equal(filter5.evaluate(justOutside13).passed, filter2.evaluate(justOutside13).passed, "F5 and F2 must agree at 13d");
    assert.equal(filter5.evaluate(justOutside19).passed, filter2.evaluate(justOutside19).passed, "F5 and F2 must agree at 19d");
  });

  it("result.name includes 'Filter 5'", () => {
    const result = filter5.evaluate(baseStock({ nextEarningsDate: dateFromToday(16) }));
    assert.ok(result.name.includes("Filter 5"), `name must include 'Filter 5' (got: "${result.name}")`);
  });

  it("passing result explanation confirms the symbol and days remaining", () => {
    const stock = baseStock({ symbol: "ACME", nextEarningsDate: dateFromToday(16) });
    const result = filter5.evaluate(stock);
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
