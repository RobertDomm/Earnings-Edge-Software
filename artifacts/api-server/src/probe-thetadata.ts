/**
 * ThetaData live gRPC probe — task #63
 *
 * Exercises the full decode pipeline against the live ThetaData endpoint,
 * confirms column-header field names, and verifies that at least one ticker
 * produces a non-null liquidityMetrics result.  Also runs the screening engine
 * against the decoded data so filter pass/fail/bypass outcomes are visible.
 *
 * SUCCESS criteria:
 *   1. quoteRows non-empty for at least one ticker
 *   2. liquidityMetrics non-null for at least one ticker
 *   3. At least one stock is qualified OR qualified_with_caveats
 *      (during market hours F3 spread and F6 calendar structure both pass;
 *       F2/F4/F5 are always bypassed in ThetaData mode — no earnings data)
 *
 * Run with:
 *   THETADATA_API_KEY=<key> pnpm --filter @workspace/api-server \
 *     exec tsx src/probe-thetadata.ts [SYMBOL ...]
 *
 * Defaults to: AAPL META AMD MSFT
 */

import { ThetaDataProvider } from "./lib/market-data.js";
import { ScreeningEngine, FILTER_RULES } from "./lib/screening-engine.js";

const SYMBOLS = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["AAPL", "META", "AMD", "MSFT"];

const TODAY = new Date();

async function main() {
  const apiKey = process.env.THETADATA_API_KEY;
  if (!apiKey) {
    console.error("THETADATA_API_KEY not set");
    process.exit(1);
  }

  console.log(`\n=== ThetaData live gRPC probe ===`);
  console.log(`    symbols : ${SYMBOLS.join(", ")}`);
  console.log(`    today   : ${TODAY.toISOString().slice(0, 10)}\n`);

  console.log("1. Creating ThetaDataProvider and waiting for init...");
  const provider = new ThetaDataProvider(apiKey, 300);
  const engine   = new ScreeningEngine(FILTER_RULES);

  const qualified:            string[] = [];
  const qualifiedWithCaveats: string[] = [];
  let quoteRowsOk   = false;
  let liquidityOk   = false;

  for (const symbol of SYMBOLS) {
    console.log(`\n── ${symbol} ──────────────────────────────────`);
    process.stdout.write("  getStockQuote... ");
    const quote = await provider.getStockQuote(symbol);

    if (!quote) {
      console.log("null (enrichTicker returned nothing)");
      continue;
    }

    if (quote.optionsVolume > 0 || quote.openInterest > 0) quoteRowsOk = true;

    console.log("OK");
    console.log(`  price=${quote.price}  iv=${quote.impliedVolatility}  vol=${quote.optionsVolume}  oi=${quote.openInterest}`);

    const lm = quote.liquidityMetrics;
    if (!lm) {
      console.log("  liquidityMetrics : null");
    } else {
      liquidityOk = true;
      console.log(`  liquidityMetrics : weekly=${lm.hasWeeklyOptions} penny=${lm.hasPennyIncrements} spread=${lm.nearTermSpread} nearIv=${lm.nearTermIv}`);
      console.log(`                     shortCall=${lm.shortCallStrike} shortPut=${lm.shortPutStrike} callPeak=${lm.callCalendarPeak} putPeak=${lm.putCalendarPeak}`);
    }

    // Run the screening engine
    const result = engine.evaluateStock(quote, TODAY);
    console.log(`  screening : status=${result.status}  score=${result.filterScore}`);
    for (const f of result.filterResults) {
      const mark = f.passed ? "✓" : f.bypassed ? "⊘" : "✗";
      const note = f.bypassed ? " [bypassed — data unavailable]" : "";
      console.log(`    ${mark} ${f.name.padEnd(40)} ${f.calculatedValue}${note}`);
    }

    if (result.qualified)            qualified.push(symbol);
    if (result.qualifiedWithCaveats) qualifiedWithCaveats.push(symbol);
  }

  console.log("\n=== Probe summary ===");
  console.log(`  quoteRows non-empty      : ${quoteRowsOk ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`  liquidityMetrics non-null: ${liquidityOk ? "✓ PASS" : "✗ FAIL"}`);

  if (qualified.length > 0) {
    console.log(`  qualifying stocks        : ✓ PASS — ${qualified.join(", ")} (fully qualified, all 6 filters passed)`);
  } else if (qualifiedWithCaveats.length > 0) {
    console.log(`  qualifying stocks        : ✓ PASS — ${qualifiedWithCaveats.join(", ")} (qualified with caveats — F2/F4/F5 bypassed; verify earnings before entry)`);
  } else {
    console.log(`  qualifying stocks        : ✗ NONE — all stocks failed at least one non-bypassed filter`);
    console.log(`    Common causes: after-hours wide spreads (F3), no 30–60¢ OTM structure (F6)`);
    console.log(`    Re-run during regular market hours (9:30 AM–4:00 PM ET) to verify F3 and F6`);
  }

  const corePass = quoteRowsOk && liquidityOk;
  const fullPass = corePass && (qualified.length > 0 || qualifiedWithCaveats.length > 0);
  console.log(`\n=== Core decode ${corePass ? "PASSED" : "FAILED"} ===`);
  console.log(`=== End-to-end ${fullPass ? "PASSED" : "NEEDS MARKET HOURS"} ===\n`);
  process.exit(fullPass ? 0 : corePass ? 2 : 1);
}

main().catch(err => {
  console.error("Probe failed:", err);
  process.exit(1);
});
