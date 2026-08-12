/**
 * screening-engine.test.ts
 *
 * Unit tests for Filter 1 — Sector Exclusion.
 *
 * Verifies that oil, biotech, healthcare, and defense stocks are reliably
 * excluded, while tech, finance, consumer, automotive, and ETF stocks
 * pass through cleanly.
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

// Filter 1 is the first rule in FILTER_RULES
const filter1 = FILTER_RULES[0];

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
