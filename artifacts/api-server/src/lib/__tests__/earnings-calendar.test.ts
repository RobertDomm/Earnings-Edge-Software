/**
 * Tests for the Nasdaq confirmed-earnings-calendar module and the
 * confirmed-vs-estimated resolution helper used by the live providers.
 *
 * Uses Node.js built-in test runner (node:test); no network access required.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getConfirmedEarningsCalendar,
  getConfirmedEarningsDate,
  clearEarningsCalendarCache,
  getHistoricalEarningsDates,
  clearHistoricalEarningsCache,
  type FetchLike,
} from "../earnings-calendar.js";
import { resolveEarningsDate } from "../market-data.js";

/** Builds a FetchLike that serves per-date Nasdaq-shaped responses. */
function nasdaqStub(
  rowsByDate: Record<string, Array<{ symbol: string }>>,
  opts: { failDates?: string[]; failAll?: boolean } = {},
): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    const date = new URL(url).searchParams.get("date")!;
    calls.push(date);
    if (opts.failAll || opts.failDates?.includes(date)) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { rows: rowsByDate[date] ?? [] } }),
    };
  };
  return { fetch, calls };
}

const TODAY = new Date("2026-08-13T12:00:00");

describe("earnings-calendar", () => {
  beforeEach(() => clearEarningsCalendarCache());

  it("builds a symbol → date map from per-day calendar rows (weekdays only)", async () => {
    const { fetch, calls } = nasdaqStub({
      "2026-08-27": [{ symbol: "AAPL" }, { symbol: "ry" }],
      "2026-09-02": [{ symbol: "MSFT" }],
    });
    const cal = await getConfirmedEarningsCalendar({ fetchImpl: fetch, today: TODAY });

    assert.equal(cal.get("AAPL"), "2026-08-27");
    assert.equal(cal.get("RY"), "2026-08-27"); // symbols normalized to uppercase
    assert.equal(cal.get("MSFT"), "2026-09-02");
    assert.equal(cal.has("TSLA"), false);
    // No weekend dates should ever be requested
    for (const d of calls) {
      const dow = new Date(d + "T00:00:00").getDay();
      assert.ok(dow >= 1 && dow <= 5, `weekend date requested: ${d}`);
    }
  });

  it("keeps the earliest date when a symbol appears on multiple days", async () => {
    const { fetch } = nasdaqStub({
      "2026-08-20": [{ symbol: "AAPL" }],
      "2026-09-10": [{ symbol: "AAPL" }],
    });
    const cal = await getConfirmedEarningsCalendar({ fetchImpl: fetch, today: TODAY });
    assert.equal(cal.get("AAPL"), "2026-08-20");
  });

  it("caches the snapshot — second lookup does not refetch", async () => {
    const { fetch, calls } = nasdaqStub({ "2026-08-27": [{ symbol: "AAPL" }] });
    await getConfirmedEarningsDate("AAPL", { fetchImpl: fetch, today: TODAY });
    const callCountAfterFirst = calls.length;
    const date = await getConfirmedEarningsDate("AAPL", { fetchImpl: fetch, today: TODAY });
    assert.equal(date, "2026-08-27");
    assert.equal(calls.length, callCountAfterFirst);
  });

  it("tolerates partial day failures — other days still populate the map", async () => {
    const { fetch } = nasdaqStub(
      { "2026-08-27": [{ symbol: "AAPL" }] },
      { failDates: ["2026-08-14"] },
    );
    const cal = await getConfirmedEarningsCalendar({ fetchImpl: fetch, today: TODAY });
    assert.equal(cal.get("AAPL"), "2026-08-27");
  });

  it("returns an empty map (never throws) when every request fails", async () => {
    const { fetch } = nasdaqStub({}, { failAll: true });
    const cal = await getConfirmedEarningsCalendar({ fetchImpl: fetch, today: TODAY });
    assert.equal(cal.size, 0);
    assert.equal(await getConfirmedEarningsDate("AAPL", { fetchImpl: fetch, today: TODAY }), null);
  });
});

describe("getHistoricalEarningsDates — Nasdaq earnings-surprise fallback", () => {
  beforeEach(() => clearHistoricalEarningsCache());

  /** Builds a FetchLike serving a Nasdaq earnings-surprise-shaped response. */
  function surpriseStub(
    rows: Array<{ dateReported?: string }> | null,
    opts: { status?: number } = {},
  ): { fetch: FetchLike; calls: string[] } {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      if (opts.status && opts.status !== 200) {
        return { ok: false, status: opts.status, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { earningsSurpriseTable: { rows } } }),
      };
    };
    return { fetch, calls };
  }

  it("parses M/D/YYYY reported dates, excludes future rows, returns most-recent-first", async () => {
    const { fetch } = surpriseStub([
      { dateReported: "9/1/2026" },   // future relative to TODAY — excluded
      { dateReported: "5/13/2026" },
      { dateReported: "3/19/2026" },
      { dateReported: "11/25/2025" },
      { dateReported: "8/29/2025" },
    ]);
    const dates = await getHistoricalEarningsDates("BABA", { fetchImpl: fetch, today: TODAY });
    assert.deepEqual(dates, ["2026-05-13", "2026-03-19", "2025-11-25", "2025-08-29"]);
  });

  it("returns null on HTTP failure and does not cache the failure", async () => {
    const failing = surpriseStub(null, { status: 503 });
    assert.equal(await getHistoricalEarningsDates("TSM", { fetchImpl: failing.fetch, today: TODAY }), null);

    // Next call retries (failure was not cached) and succeeds
    const ok = surpriseStub([{ dateReported: "7/16/2026" }]);
    const dates = await getHistoricalEarningsDates("TSM", { fetchImpl: ok.fetch, today: TODAY });
    assert.deepEqual(dates, ["2026-07-16"]);
  });

  it("returns null when rows are missing or contain no past dates", async () => {
    const { fetch } = surpriseStub([{ dateReported: "12/31/2026" }, { dateReported: "garbage" }, {}]);
    assert.equal(await getHistoricalEarningsDates("NIO", { fetchImpl: fetch, today: TODAY }), null);
  });

  it("caches successful lookups per symbol — second call does not refetch", async () => {
    const { fetch, calls } = surpriseStub([{ dateReported: "5/13/2026" }]);
    await getHistoricalEarningsDates("BABA", { fetchImpl: fetch, today: TODAY });
    assert.equal(calls.length, 1);
    const dates = await getHistoricalEarningsDates("baba", { fetchImpl: fetch, today: TODAY });
    assert.deepEqual(dates, ["2026-05-13"]);
    assert.equal(calls.length, 1, "cached symbol must not trigger a second fetch");
  });
});

describe("resolveEarningsDate — confirmed overlay on the +91-day estimate", () => {
  beforeEach(() => clearEarningsCalendarCache());

  it("prefers the confirmed calendar date over the estimate", async () => {
    const { fetch } = nasdaqStub({ "2026-08-27": [{ symbol: "AAPL" }] });
    // Prime the shared cache with the stubbed calendar
    await getConfirmedEarningsCalendar({ fetchImpl: fetch, today: TODAY });

    const resolved = await resolveEarningsDate("AAPL", "2026-08-30");
    assert.deepEqual(resolved, { nextEarningsDate: "2026-08-27", earningsDateSource: "confirmed" });
  });

  it("falls back to the estimate when the calendar has no entry", async () => {
    const { fetch } = nasdaqStub({});
    await getConfirmedEarningsCalendar({ fetchImpl: fetch, today: TODAY });

    const resolved = await resolveEarningsDate("TSLA", "2026-08-30");
    assert.deepEqual(resolved, { nextEarningsDate: "2026-08-30", earningsDateSource: "estimated" });
  });

  it("returns nulls when neither a confirmed date nor an estimate exists", async () => {
    const { fetch } = nasdaqStub({});
    await getConfirmedEarningsCalendar({ fetchImpl: fetch, today: TODAY });

    const resolved = await resolveEarningsDate("SPY", null);
    assert.deepEqual(resolved, { nextEarningsDate: null, earningsDateSource: null });
  });
});
