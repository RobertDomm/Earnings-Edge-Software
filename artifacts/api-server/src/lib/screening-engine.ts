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
  /** One-sentence summary of what this filter checks */
  description: string;
  /** Representative threshold string for display (stock-price-independent) */
  defaultThreshold: string;
  /** Evaluate this rule against a single stock quote.
   * @param today  Optional override for "today" (defaults to `new Date()`).
   *               Pass a fixed value in tests to make assertions hermetic. */
  evaluate(stock: StockQuote, today?: Date): FilterResult;
}

// ---------------------------------------------------------------------------
// PLACEHOLDER FILTER RULES
// Replace with real criteria when the client's strategy is supplied.
// Each rule must implement IFilterRule.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Filter 1 — Sector Exclusion
//
// Oil, biotech, healthcare, and military defense stocks are excluded because
// their price action is driven more by sector-specific catalysts (oil reports,
// FDA approvals, government contracts) than by earnings — making them unsuitable
// for this system's strategy.
// ---------------------------------------------------------------------------

const EXCLUDED_SECTORS = new Set(["oil", "biotech", "healthcare", "defense"]);

const SECTOR_LABELS: Record<string, string> = {
  oil:        "Oil & Energy",
  biotech:    "Biotech",
  healthcare: "Healthcare",
  defense:    "Military Defense",
  tech:       "Technology",
  finance:    "Finance",
  consumer:   "Consumer",
  automotive: "Automotive",
  etf:        "ETF",
  other:      "Other",
};

const filter1: IFilterRule = {
  name: "Filter 1 — Sector Exclusion",
  description: "Excludes oil, biotech, healthcare, and military defense stocks whose price action is driven by sector-specific catalysts rather than earnings.",
  defaultThreshold: "Not oil, biotech, healthcare, or military defense",
  evaluate(stock) {
    const sector = stock.sector ?? "other";
    const excluded = EXCLUDED_SECTORS.has(sector);
    const passed = !excluded;
    const sectorLabel = SECTOR_LABELS[sector] ?? sector;
    return {
      name: this.name,
      passed,
      calculatedValue: sectorLabel,
      threshold: "Not oil, biotech, healthcare, or military defense",
      explanation: passed
        ? `${stock.symbol} (${sectorLabel}) is not in an excluded sector — eligible for screening.`
        : `${stock.symbol} is in the ${sectorLabel} sector. Excluded because price action relies on sector-specific catalysts (oil reports, FDA approvals, government contracts) rather than earnings.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Filter 2 — Earnings in 2 Weeks (14–18 days out)
//
// The entry point is when earnings are exactly 2 weeks away — meaning the
// earnings announcement falls somewhere in the target week (14–18 days out).
// This covers any day of the earnings week (Mon–Fri = 5-day span).
// Stocks with no earnings date (ETFs, unknowns) do not qualify.
// ---------------------------------------------------------------------------

const EARNINGS_WINDOW_MIN = 14;
const EARNINGS_WINDOW_MAX = 18;

const filter2: IFilterRule = {
  name: "Filter 2 — Earnings in 2 Weeks",
  description: "Selects stocks whose next earnings announcement falls 14–18 calendar days out — the entry window for this strategy.",
  defaultThreshold: `Earnings ${EARNINGS_WINDOW_MIN}–${EARNINGS_WINDOW_MAX} days out`,
  evaluate(stock, today?: Date) {
    if (!stock.nextEarningsDate) {
      return {
        name: this.name,
        passed: false,
        calculatedValue: "No earnings date",
        threshold: `Earnings ${EARNINGS_WINDOW_MIN}–${EARNINGS_WINDOW_MAX} days out`,
        explanation: `No upcoming earnings date found for ${stock.symbol} — cannot confirm a 2-week catalyst.`,
      };
    }

    const _today = new Date(today ?? new Date());
    _today.setHours(0, 0, 0, 0);
    const earningsDate = new Date(stock.nextEarningsDate + "T00:00:00");
    const daysUntil = Math.round(
      (earningsDate.getTime() - _today.getTime()) / (1000 * 60 * 60 * 24)
    );

    const passed = daysUntil >= EARNINGS_WINDOW_MIN && daysUntil <= EARNINGS_WINDOW_MAX;

    return {
      name: this.name,
      passed,
      calculatedValue:
        daysUntil < 0
          ? `${Math.abs(daysUntil)}d ago`
          : `${daysUntil}d (${stock.nextEarningsDate})`,
      threshold: `Earnings ${EARNINGS_WINDOW_MIN}–${EARNINGS_WINDOW_MAX} days out`,
      explanation: passed
        ? `${stock.symbol} reports in ${daysUntil} days (${stock.nextEarningsDate}) — squarely in the 2-week entry window.`
        : daysUntil < 0
        ? `${stock.symbol}'s most recent earnings were ${Math.abs(daysUntil)} days ago. Next cycle not yet estimated.`
        : daysUntil < EARNINGS_WINDOW_MIN
        ? `${stock.symbol} reports in ${daysUntil} days — too close to enter. The window opens at ${EARNINGS_WINDOW_MIN} days out.`
        : `${stock.symbol} reports in ${daysUntil} days — too early. Enter when earnings are ${EARNINGS_WINDOW_MIN}–${EARNINGS_WINDOW_MAX} days out.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Filter 3 — Options Liquidity
//
// All four sub-rules from the Earnings Edge liquidity checklist must pass:
//   1. Weekly options available (tighter spreads, more volume)
//   2. Penny-increment quoting (not nickel-only — indicates deeper market)
//   3. Near-term ($0.30–$0.60) options have a spread within the price-tier limit
//
// Max spread table (matching the user's spec):
//   $0–$100   → $0.10
//   $100–$250 → $0.30
//   $250–$500 → $0.40
//   $500–$1k  → $0.50
// ---------------------------------------------------------------------------

function maxSpreadForPrice(stockPrice: number): number {
  if (stockPrice < 100)  return 0.10;
  if (stockPrice < 250)  return 0.30;
  if (stockPrice < 500)  return 0.40;
  return 0.50; // $500–$1,000 (screener universe cap)
}

const filter3: IFilterRule = {
  name: "Filter 3 — Options Liquidity",
  description: "Requires weekly options, penny-increment quoting, and near-term spreads within the price-tier limit ($0.10–$0.50 depending on stock price).",
  defaultThreshold: "Weekly • Penny • Spread within price-tier limit",
  evaluate(stock) {
    const lm = stock.liquidityMetrics;

    if (!lm) {
      return {
        name: this.name,
        passed: false,
        calculatedValue: "No options data",
        threshold: "Weekly • Penny • Spread within limit",
        explanation: `No options liquidity data available for ${stock.symbol}.`,
      };
    }

    const maxSpread = maxSpreadForPrice(stock.price);
    const spreadOk = lm.nearTermSpread !== null && lm.nearTermSpread <= maxSpread;
    const passed = lm.hasWeeklyOptions && lm.hasPennyIncrements && spreadOk;

    const dteNote = lm.nearTermDte !== null ? ` (${lm.nearTermDte} DTE chain)` : "";

    const checks = [
      lm.hasWeeklyOptions   ? "Weekly✓"  : "Weekly✗",
      lm.hasPennyIncrements ? "Penny✓"   : "Penny✗",
      lm.nearTermSpread !== null
        ? `Spread $${lm.nearTermSpread.toFixed(2)}${spreadOk ? "✓" : "✗"}`
        : "Spread —",
    ].join("  ");

    const failReasons: string[] = [];
    if (!lm.hasWeeklyOptions)
      failReasons.push("No weekly options — monthly-only expirations tend to have wider spreads.");
    if (!lm.hasPennyIncrements)
      failReasons.push("Options quoted only in $0.05 increments, indicating lower market-maker competition.");
    if (!spreadOk) {
      failReasons.push(
        lm.nearTermSpread !== null
          ? `Avg spread $${lm.nearTermSpread.toFixed(2)}${dteNote} exceeds the $${maxSpread.toFixed(2)} limit for a $${stock.price.toFixed(0)} stock.`
          : `No near-term options found in the $0.30–$0.60 range${dteNote}.`
      );
    }

    return {
      name: this.name,
      passed,
      calculatedValue: checks,
      threshold: `Weekly • Penny • Spread ≤ $${maxSpread.toFixed(2)}`,
      explanation: passed
        ? `${stock.symbol} passes all liquidity checks${dteNote}: weekly options available, penny-increment quotes, avg spread $${lm.nearTermSpread!.toFixed(2)} vs. $${maxSpread.toFixed(2)} limit.`
        : failReasons.join(" "),
    };
  },
};

// ---------------------------------------------------------------------------
// Filter 4 — IV Rise into Earnings (last 4 cycles)
//
// The strategy profits from pre-earnings IV expansion. A stock only qualifies
// if IV consistently rises in the days leading up to each of its last 4
// earnings events. A single cycle where IV failed to expand means the stock
// does not reliably exhibit the pattern and should be skipped.
//
// In the live provider, "IV" is approximated by annualized close-to-close
// realized volatility computed from Polygon stock aggregates — the best proxy
// available without historical options IV data.
// ---------------------------------------------------------------------------

const REQUIRED_IV_CYCLES = 4;

const filter4: IFilterRule = {
  name: "Filter 4 — IV Rise into Earnings",
  description: "Checks that realized volatility (used as a proxy for IV, computed from Polygon stock aggregates) rose into earnings in each of the last 4 quarterly cycles — evidence of a consistent pre-earnings volatility run-up.",
  defaultThreshold: `${REQUIRED_IV_CYCLES}/${REQUIRED_IV_CYCLES} cycles show RV expansion`,
  evaluate(stock) {
    const history = stock.earningsIvHistory;

    if (!history || history.length < REQUIRED_IV_CYCLES) {
      return {
        name: this.name,
        passed: false,
        calculatedValue: `${history?.length ?? 0}/${REQUIRED_IV_CYCLES} cycles`,
        threshold: `${REQUIRED_IV_CYCLES}/${REQUIRED_IV_CYCLES} cycles show IV expansion`,
        explanation: `Insufficient earnings history for ${stock.symbol} — need ${REQUIRED_IV_CYCLES} quarters of data, found ${history?.length ?? 0}.`,
      };
    }

    const risingCycles = history.filter((r) => r.ivRose).length;
    const passed = risingCycles === REQUIRED_IV_CYCLES;

    // Build per-cycle detail: "Aug✓ Nov✓ Feb✓ May✓"
    const monthAbbr = (d: string) =>
      new Date(d + "T00:00:00").toLocaleString("en-US", { month: "short" });
    const cycleDetail = history
      .map((r) => `${monthAbbr(r.earningsDate)}${r.ivRose ? "✓" : "✗"}`)
      .join(" ");

    const failCycles = history
      .filter((r) => !r.ivRose)
      .map(
        (r) =>
          `${monthAbbr(r.earningsDate)} ${r.earningsDate.slice(0, 4)} (RV ${(r.ivBaseline * 100).toFixed(1)}% → ${(r.ivBeforeEarnings * 100).toFixed(1)}%)`
      );

    return {
      name: this.name,
      passed,
      calculatedValue: `${risingCycles}/${REQUIRED_IV_CYCLES}  ${cycleDetail}`,
      threshold: `${REQUIRED_IV_CYCLES}/${REQUIRED_IV_CYCLES} cycles show IV expansion`,
      explanation: passed
        ? `${stock.symbol} showed IV expansion into earnings in all ${REQUIRED_IV_CYCLES} of the last ${REQUIRED_IV_CYCLES} cycles (${cycleDetail}) — consistent pre-earnings IV run-up confirmed.`
        : `${stock.symbol} failed to show IV expansion in ${REQUIRED_IV_CYCLES - risingCycles} cycle(s): ${failCycles.join("; ")}. Inconsistent pre-earnings IV behaviour makes this a poor candidate for this strategy.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Filter 5 — Verify Earnings Are 2 Weeks Out (final gate)
//
// Final re-confirmation that earnings still fall in the 14–18 day window.
// Filter 2 makes the initial cut; Filter 5 is the explicit sign-off at the
// end of the checklist before a position is considered.
// ---------------------------------------------------------------------------

const filter5: IFilterRule = {
  name: "Filter 5 — Earnings Verified 2 Weeks Out",
  description: "Final re-confirmation that earnings still fall in the 14–18 day window — the explicit sign-off before a position is considered.",
  defaultThreshold: `Earnings ${EARNINGS_WINDOW_MIN}–${EARNINGS_WINDOW_MAX} days out`,
  evaluate(stock, today?: Date) {
    if (!stock.nextEarningsDate) {
      return {
        name: this.name,
        passed: false,
        calculatedValue: "No earnings date",
        threshold: `Earnings ${EARNINGS_WINDOW_MIN}–${EARNINGS_WINDOW_MAX} days out`,
        explanation: `No confirmed earnings date for ${stock.symbol} — cannot verify the 2-week window.`,
      };
    }

    const _today = new Date(today ?? new Date());
    _today.setHours(0, 0, 0, 0);
    const earningsDate = new Date(stock.nextEarningsDate + "T00:00:00");
    const daysUntil = Math.round(
      (earningsDate.getTime() - _today.getTime()) / 86_400_000
    );
    const passed = daysUntil >= EARNINGS_WINDOW_MIN && daysUntil <= EARNINGS_WINDOW_MAX;

    return {
      name: this.name,
      passed,
      calculatedValue:
        daysUntil < 0
          ? `${Math.abs(daysUntil)}d ago`
          : `${daysUntil}d (${stock.nextEarningsDate})`,
      threshold: `Earnings ${EARNINGS_WINDOW_MIN}–${EARNINGS_WINDOW_MAX} days out`,
      explanation: passed
        ? `✔ Confirmed: ${stock.symbol} reports in ${daysUntil} days (${stock.nextEarningsDate}) — in the 2-week entry window.`
        : daysUntil < 0
        ? `${stock.symbol}'s most recent earnings were ${Math.abs(daysUntil)} days ago. Waiting for next cycle.`
        : daysUntil < EARNINGS_WINDOW_MIN
        ? `${stock.symbol} reports in ${daysUntil} days — window has closed. Too late to enter.`
        : `${stock.symbol} reports in ${daysUntil} days — not yet in the entry window.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Filter 6 — Double Calendar Structure
//
// For the double calendar trade (short 11 DTE, long 18 DTE at same strikes),
// both peaks of the risk graph must sit ABOVE the zero line at the short's
// expiry. The call-side peak is the calendar P&L when the stock lands at the
// call strike; the put-side peak is the P&L when the stock lands at the put
// strike. Both must be positive for the trade structure to qualify.
//
//   callCalendarPeak = bsAtm(callStrike, long18DteIV, 7d) − total debit
//   putCalendarPeak  = bsAtm(putStrike,  long18DteIV, 7d) − total debit
//
// A negative peak means the long option's remaining value at the short's
// expiry does not cover the net debit paid — the trade loses money even in
// the best-case scenario.
// ---------------------------------------------------------------------------

const filter6: IFilterRule = {
  name: "Filter 6 — Double Calendar Structure",
  description:
    "Verifies that a double calendar spread (short 11 DTE, long 18 DTE) at the 30–60¢ OTM strikes produces a risk graph where both peaks sit above the zero line — confirming the trade structure is viable before entry.",
  defaultThreshold: "Both calendar peaks > $0 at short expiry",
  evaluate(stock) {
    const lm = stock.liquidityMetrics;

    if (
      !lm ||
      lm.shortCallStrike == null ||
      lm.shortPutStrike == null ||
      lm.callCalendarPeak == null ||
      lm.putCalendarPeak == null
    ) {
      return {
        name: this.name,
        passed: false,
        calculatedValue: "No calendar data",
        threshold: "Both peaks > $0",
        explanation: `No double calendar data for ${stock.symbol} — the options chain did not contain both 11 DTE and 18 DTE contracts with 30–60¢ OTM strikes.`,
      };
    }

    const passed = lm.callCalendarPeak > 0 && lm.putCalendarPeak > 0;
    const fmt = (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;

    const callDesc = `${lm.shortCallStrike} call: ${fmt(lm.callCalendarPeak)}`;
    const putDesc  = `${lm.shortPutStrike} put: ${fmt(lm.putCalendarPeak)}`;

    return {
      name: this.name,
      passed,
      calculatedValue: `${fmt(lm.callCalendarPeak)} call  /  ${fmt(lm.putCalendarPeak)} put`,
      threshold: "Both peaks > $0",
      explanation: passed
        ? `Both risk-graph peaks are above zero — ${callDesc}; ${putDesc}. The double calendar structure is viable.`
        : `${
            lm.callCalendarPeak <= 0 && lm.putCalendarPeak <= 0
              ? `Both peaks are at or below zero (${callDesc}; ${putDesc}).`
              : lm.callCalendarPeak <= 0
              ? `Call-side peak is below zero (${callDesc}; ${putDesc}). The 18 DTE long at $${lm.shortCallStrike} is priced too high relative to its remaining value at the short's expiry.`
              : `Put-side peak is below zero (${callDesc}; ${putDesc}). The 18 DTE long at $${lm.shortPutStrike} is priced too high relative to its remaining value at the short's expiry.`
          } Skipping — risk graph does not show a proper double calendar structure.`,
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
  filter6,
];

/**
 * Returns static metadata for each active filter rule — name, description,
 * and a representative threshold string suitable for display in the UI.
 * All currently active rules are fully implemented.
 */
export function getFilterDefinitions() {
  return FILTER_RULES.map((rule) => ({
    name: rule.name,
    description: rule.description,
    threshold: rule.defaultThreshold,
    implemented: true,
  }));
}

// ---------------------------------------------------------------------------
// Screening Engine
// ---------------------------------------------------------------------------

export class ScreeningEngine {
  private rules: IFilterRule[];

  constructor(rules: IFilterRule[] = FILTER_RULES) {
    this.rules = rules;
  }

  /** Run all filter rules against a single stock.
   * @param today  Optional override for "today" (defaults to `new Date()`).
   *               Pass a fixed value in tests to make assertions hermetic. */
  evaluateStock(stock: StockQuote, today?: Date): ScreeningResult {
    const filterResults = this.rules.map((rule) => rule.evaluate(stock, today));
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

  /** Run all filter rules against the full stock universe.
   * @param today  Optional override for "today" (defaults to `new Date()`).
   *               Pass a fixed value in tests to make assertions hermetic. */
  runScreening(stocks: StockQuote[], today?: Date): ScreeningResult[] {
    return stocks.map((stock) => this.evaluateStock(stock, today));
  }
}

export const screeningEngine = new ScreeningEngine(FILTER_RULES);
