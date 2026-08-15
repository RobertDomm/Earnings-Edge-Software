/**
 * Tests for the TMX Corporate Events module (Polygon add-on) and its
 * interaction with resolveEarningsDate's source-precedence chain.
 *
 * Uses Node.js built-in test runner (node:test); stubs global fetch —
 * no network access required.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  fetchTmxEarningsEvents,
  fetchTmxEarningsEventsCached,
  clearTmxEventsCache,
  type TmxFetchOptions,
} from "../tmx-events.js";
import {
  resolveEarningsDate,
  fetchPolygonEarningsData,
  fetchPolygonEarningsDataCached,
  clearPolygonEarningsCache,
} from "../market-data.js";

const TODAY = "2026-08-14";

type FetchStub = { calls: string[]; restore: () => void };

/** Replaces global fetch with a stub serving the given responses in order (last repeats). */
function stubFetch(
  responses: Array<{ ok: boolean; status: number; body?: unknown } | Error>,
): FetchStub {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body ?? {},
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function row(date: string, type: string, status?: string) {
  return { date, type, status };
}

const FAST: TmxFetchOptions = { retryBaseMs: 1, todayYmd: TODAY };

describe("fetchTmxEarningsEvents — parsing and extraction", () => {
  let stub: FetchStub | null = null;
  afterEach(() => { stub?.restore(); stub = null; });

  it("extracts earliest confirmed future date and past dates most-recent-first", async () => {
    stub = stubFetch([{ ok: true, status: 200, body: { results: [
      row("2026-11-19", "earnings_announcement_date", "confirmed"),
      row("2026-08-20", "earnings_announcement_date", "confirmed"),
      row("2026-05-14", "earnings_results_announcement"),
      row("2026-02-11", "earnings_announcement_date", "confirmed"),
      row("2025-11-15", "earnings_results_announcement"),
    ] } }]);
    const res = await fetchTmxEarningsEvents("k", "BABA", FAST);
    assert.deepEqual(res, {
      nextEarningsDate: "2026-08-20",
      historicalEarningsDates: ["2026-05-14", "2026-02-11", "2025-11-15"],
    });
  });

  it("ignores non-earnings event types and unconfirmed/estimated future dates", async () => {
    stub = stubFetch([{ ok: true, status: 200, body: { results: [
      row("2026-09-01", "dividend_payment_date", "confirmed"),
      row("2026-09-10", "earnings_announcement_date", "estimated"),
      row("2026-09-12", "earnings_announcement_date"), // no status
      row("2026-09-15", "earnings_results_announcement", "confirmed"), // wrong type for future
      row("2026-05-01", "annual_general_meeting"),
    ] } }]);
    const res = await fetchTmxEarningsEvents("k", "TSM", FAST);
    assert.deepEqual(res, { nextEarningsDate: null, historicalEarningsDates: [] });
  });

  it("dedupes past dates and skips rows without a date", async () => {
    stub = stubFetch([{ ok: true, status: 200, body: { results: [
      row("2026-05-14", "earnings_announcement_date", "confirmed"),
      row("2026-05-14", "earnings_results_announcement"),
      { type: "earnings_announcement_date", status: "confirmed" },
    ] } }]);
    const res = await fetchTmxEarningsEvents("k", "JD", FAST);
    assert.deepEqual(res!.historicalEarningsDates, ["2026-05-14"]);
  });

  it("handles missing/null results and empty responses", async () => {
    stub = stubFetch([{ ok: true, status: 200, body: { results: null } }]);
    const res = await fetchTmxEarningsEvents("k", "NIO", FAST);
    assert.deepEqual(res, { nextEarningsDate: null, historicalEarningsDates: [] });
  });

  it("retries transient 5xx/429 then succeeds", async () => {
    stub = stubFetch([
      { ok: false, status: 503 },
      { ok: false, status: 429 },
      { ok: true, status: 200, body: { results: [row("2026-08-20", "earnings_announcement_date", "confirmed")] } },
    ]);
    const res = await fetchTmxEarningsEvents("k", "BABA", { ...FAST, retries: 2 });
    assert.equal(res!.nextEarningsDate, "2026-08-20");
    assert.equal(stub.calls.length, 3);
  });

  it("returns null (never throws) on non-retryable auth errors without retrying", async () => {
    stub = stubFetch([{ ok: false, status: 403 }]);
    const res = await fetchTmxEarningsEvents("k", "BABA", { ...FAST, retries: 2 });
    assert.equal(res, null);
    assert.equal(stub.calls.length, 1, "auth errors must not be retried");
  });

  it("returns null after exhausting retries on network failure", async () => {
    stub = stubFetch([new Error("ECONNRESET")]);
    const res = await fetchTmxEarningsEvents("k", "BABA", { ...FAST, retries: 1 });
    assert.equal(res, null);
    assert.equal(stub.calls.length, 2);
  });

  it("awaits acquireSlot before every HTTP request, including retries", async () => {
    stub = stubFetch([
      { ok: false, status: 500 },
      { ok: true, status: 200, body: { results: [] } },
    ]);
    let slots = 0;
    await fetchTmxEarningsEvents("k", "BABA", {
      ...FAST,
      retries: 1,
      acquireSlot: async () => { slots++; },
    });
    assert.equal(slots, 2, "each attempt must hold a rate-limiter slot");
  });
});

describe("fetchTmxEarningsEventsCached — 24h success-only cache", () => {
  let stub: FetchStub | null = null;
  beforeEach(() => clearTmxEventsCache());
  afterEach(() => { stub?.restore(); stub = null; });

  it("caches successes — second call does not refetch", async () => {
    stub = stubFetch([{ ok: true, status: 200, body: { results: [
      row("2026-08-20", "earnings_announcement_date", "confirmed"),
    ] } }]);
    await fetchTmxEarningsEventsCached("k", "BABA", FAST);
    const res = await fetchTmxEarningsEventsCached("k", "BABA", FAST);
    assert.equal(res!.nextEarningsDate, "2026-08-20");
    assert.equal(stub.calls.length, 1);
  });

  it("does not cache failures — next call retries and can succeed", async () => {
    stub = stubFetch([
      { ok: false, status: 403 },
      { ok: true, status: 200, body: { results: [row("2026-08-20", "earnings_announcement_date", "confirmed")] } },
    ]);
    assert.equal(await fetchTmxEarningsEventsCached("k", "BABA", FAST), null);
    const res = await fetchTmxEarningsEventsCached("k", "BABA", FAST);
    assert.equal(res!.nextEarningsDate, "2026-08-20");
    assert.equal(stub.calls.length, 2);
  });
});

describe("fetchPolygonEarningsData — TMX confirmed history is the primary Filter 4 anchor", () => {
  // 4 SEC filing dates vs 4 TMX-confirmed announcement dates. The aggregates
  // request range reveals which set anchored the IV history: its `to` date is
  // (mostRecentDate - 1 day).
  const FILINGS = ["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30"];
  const TMX_DATES = ["2026-05-14", "2026-02-11", "2025-11-15", "2025-08-12"];

  /** Stubs global fetch for Polygon financials + aggregates endpoints. */
  function stubPolygon(): { aggsUrls: string[]; financialsCalls: () => number; restore: () => void } {
    const original = globalThis.fetch;
    const aggsUrls: string[] = [];
    let fin = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/vX/reference/financials")) {
        fin++;
        return {
          ok: true, status: 200,
          json: async () => ({ results: FILINGS.map((d) => ({ filing_date: d })) }),
        } as Response;
      }
      if (url.includes("/v2/aggs/")) {
        aggsUrls.push(url);
        return { ok: true, status: 200, json: async () => ({ results: [] }) } as Response;
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;
    return { aggsUrls, financialsCalls: () => fin, restore: () => { globalThis.fetch = original; } };
  }

  it("anchors IV history on TMX dates even when Polygon has 4 filings", async () => {
    const stub = stubPolygon();
    try {
      await fetchPolygonEarningsData("k", "AAPL", {
        retryBaseMs: 1,
        confirmedHistoricalDates: TMX_DATES,
      });
      assert.equal(stub.aggsUrls.length, 1);
      // to-date = most recent TMX date - 1 day (not filing date - 1)
      assert.ok(stub.aggsUrls[0]!.includes("/2026-05-13?"), `aggs range must end at TMX[0]-1: ${stub.aggsUrls[0]}`);
    } finally {
      stub.restore();
    }
  });

  it("falls back to filings when fewer than 4 TMX dates are supplied", async () => {
    const stub = stubPolygon();
    try {
      await fetchPolygonEarningsData("AAPL2", "AAPL", {
        retryBaseMs: 1,
        confirmedHistoricalDates: TMX_DATES.slice(0, 2),
      });
      assert.ok(stub.aggsUrls[0]!.includes("/2026-06-29?"), `aggs range must end at filing[0]-1: ${stub.aggsUrls[0]}`);
    } finally {
      stub.restore();
    }
  });

  it("cached: a pre-TMX result cannot mask a later TMX-anchored recomputation", async () => {
    clearPolygonEarningsCache();
    const stub = stubPolygon();
    try {
      // First scan: no TMX data yet → filings-anchored result gets cached.
      await fetchPolygonEarningsDataCached("k", "AAPL", { retryBaseMs: 1 });
      assert.equal(stub.financialsCalls(), 1);

      // TMX becomes available → must recompute (different cache key), anchored on TMX.
      await fetchPolygonEarningsDataCached("k", "AAPL", {
        retryBaseMs: 1,
        confirmedHistoricalDates: TMX_DATES,
      });
      assert.equal(stub.financialsCalls(), 2, "TMX arrival must bypass the pre-TMX cache entry");
      assert.ok(stub.aggsUrls[1]!.includes("/2026-05-13?"), "recomputation must anchor on TMX dates");

      // Both variants now cached — repeat calls hit the cache.
      await fetchPolygonEarningsDataCached("k", "AAPL", { retryBaseMs: 1 });
      await fetchPolygonEarningsDataCached("k", "AAPL", { retryBaseMs: 1, confirmedHistoricalDates: TMX_DATES });
      assert.equal(stub.financialsCalls(), 2);
    } finally {
      stub.restore();
      clearPolygonEarningsCache();
    }
  });
});

describe("resolveEarningsDate — TMX confirmed date takes precedence", () => {
  it("short-circuits on the TMX date without touching the Nasdaq calendar", async () => {
    // No fetch stub installed: a network call here would hit the real Nasdaq
    // API. Instead, install a fetch that throws to prove it is never invoked.
    const stub = stubFetch([new Error("network must not be touched")]);
    try {
      const resolved = await resolveEarningsDate("BABA", "2026-08-30", "2026-08-20");
      assert.deepEqual(resolved, { nextEarningsDate: "2026-08-20", earningsDateSource: "confirmed" });
      assert.equal(stub.calls.length, 0, "TMX date must short-circuit before any network call");
    } finally {
      stub.restore();
    }
  });
});
