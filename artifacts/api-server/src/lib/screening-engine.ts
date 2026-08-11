/**
 * Modular Stock Screening Engine
 *
 * Architecture:
 *   StockQuote[] → FilterRule[] → ScreeningResult[]
 *
 * Each FilterRule is independent. Adding, removing, or modifying filters
 * requires only editing the FILTER_RULES array at the bottom of this file.
 * No changes to routes or the ScreeningEngine class are needed.
 *
 * FilterResult shape (matches OpenAPI spec):
 *   { name, passed, calculatedValue, threshold, explanation }
 *
 * When the client provides the real filtering criteria, replace the placeholder
 * rules in FILTER_RULES with the actual implementations.
 */

import type { StockQuote } from "./market-data.js";

export interface FilterResult {
  name: string;
  passed: boolean;
  calculatedValue: string;
  threshold: string;
  explanation: string;
}

export interface ScreeningResult {
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
  filterResults: FilterResult[];
  filterScore: number; // 0–100, percentage of filters passed
  qualified: boolean;
  status: "qualified" | "not_qualified";
}

export interface IFilterRule {
  name: string;
  /** Evaluate this rule against a single stock quote */
  evaluate(stock: StockQuote): FilterResult;
}

// ---------------------------------------------------------------------------
// PLACEHOLDER FILTER RULES
// Replace with real criteria when the client's strategy is supplied.
// Each rule must implement IFilterRule.
// ---------------------------------------------------------------------------

/** Filter 1 — Placeholder: Minimum Implied Volatility */
const filter1: IFilterRule = {
  name: "Filter 1 — Implied Volatility Floor",
  evaluate(stock) {
    const threshold = 0.2;
    const passed = stock.impliedVolatility >= threshold;
    return {
      name: this.name,
      passed,
      calculatedValue: `${(stock.impliedVolatility * 100).toFixed(1)}%`,
      threshold: `>= ${(threshold * 100).toFixed(0)}%`,
      explanation: passed
        ? `IV of ${(stock.impliedVolatility * 100).toFixed(1)}% meets the minimum volatility floor.`
        : `IV of ${(stock.impliedVolatility * 100).toFixed(1)}% is below the minimum threshold.`,
    };
  },
};

/** Filter 2 — Placeholder: Options Volume Threshold */
const filter2: IFilterRule = {
  name: "Filter 2 — Options Volume",
  evaluate(stock) {
    const threshold = 200_000;
    const passed = stock.optionsVolume >= threshold;
    return {
      name: this.name,
      passed,
      calculatedValue: stock.optionsVolume.toLocaleString(),
      threshold: `>= ${threshold.toLocaleString()}`,
      explanation: passed
        ? `Options volume of ${stock.optionsVolume.toLocaleString()} meets the liquidity requirement.`
        : `Options volume of ${stock.optionsVolume.toLocaleString()} is below the required liquidity threshold.`,
    };
  },
};

/** Filter 3 — Placeholder: Minimum Stock Volume */
const filter3: IFilterRule = {
  name: "Filter 3 — Stock Liquidity",
  evaluate(stock) {
    const threshold = 10_000_000;
    const passed = stock.volume >= threshold;
    return {
      name: this.name,
      passed,
      calculatedValue: stock.volume.toLocaleString(),
      threshold: `>= ${threshold.toLocaleString()}`,
      explanation: passed
        ? `Daily volume of ${stock.volume.toLocaleString()} demonstrates sufficient liquidity.`
        : `Daily volume of ${stock.volume.toLocaleString()} is below the minimum liquidity threshold.`,
    };
  },
};

/** Filter 4 — Placeholder: Open Interest Requirement */
const filter4: IFilterRule = {
  name: "Filter 4 — Open Interest",
  evaluate(stock) {
    const threshold = 500_000;
    const passed = stock.openInterest >= threshold;
    return {
      name: this.name,
      passed,
      calculatedValue: stock.openInterest.toLocaleString(),
      threshold: `>= ${threshold.toLocaleString()}`,
      explanation: passed
        ? `Open interest of ${stock.openInterest.toLocaleString()} meets the requirement.`
        : `Open interest of ${stock.openInterest.toLocaleString()} is below the threshold.`,
    };
  },
};

/** Filter 5 — Placeholder: Volume vs Average Volume Ratio */
const filter5: IFilterRule = {
  name: "Filter 5 — Volume/AvgVolume Ratio",
  evaluate(stock) {
    const threshold = 0.8;
    const ratio = stock.avgVolume > 0 ? stock.volume / stock.avgVolume : 0;
    const passed = ratio >= threshold;
    return {
      name: this.name,
      passed,
      calculatedValue: ratio.toFixed(2) + "x",
      threshold: `>= ${threshold}x`,
      explanation: passed
        ? `Volume ratio of ${ratio.toFixed(2)}x indicates normal or elevated trading activity.`
        : `Volume ratio of ${ratio.toFixed(2)}x suggests unusually low activity versus average.`,
    };
  },
};

/**
 * The active filter rules.
 * To add/remove/modify rules, edit this array only.
 * Order matters — rules are evaluated left to right and displayed in this order.
 */
export const FILTER_RULES: IFilterRule[] = [
  filter1,
  filter2,
  filter3,
  filter4,
  filter5,
];

// ---------------------------------------------------------------------------
// Screening Engine
// ---------------------------------------------------------------------------

export class ScreeningEngine {
  private rules: IFilterRule[];

  constructor(rules: IFilterRule[] = FILTER_RULES) {
    this.rules = rules;
  }

  /** Run all filter rules against a single stock */
  evaluateStock(stock: StockQuote): ScreeningResult {
    const filterResults = this.rules.map((rule) => rule.evaluate(stock));
    const passed = filterResults.filter((r) => r.passed).length;
    const filterScore = this.rules.length > 0
      ? Math.round((passed / this.rules.length) * 100)
      : 0;
    const qualified = passed === this.rules.length;

    return {
      symbol: stock.symbol,
      company: stock.company,
      price: stock.price,
      dailyChangePercent: stock.dailyChangePercent,
      volume: stock.volume,
      avgVolume: stock.avgVolume,
      marketCap: stock.marketCap,
      impliedVolatility: stock.impliedVolatility,
      optionsVolume: stock.optionsVolume,
      openInterest: stock.openInterest,
      filterResults,
      filterScore,
      qualified,
      status: qualified ? "qualified" : "not_qualified",
    };
  }

  /** Run all filter rules against the full stock universe */
  runScreening(stocks: StockQuote[]): ScreeningResult[] {
    return stocks.map((stock) => this.evaluateStock(stock));
  }
}

export const screeningEngine = new ScreeningEngine(FILTER_RULES);
