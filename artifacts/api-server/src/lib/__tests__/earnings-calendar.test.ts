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
