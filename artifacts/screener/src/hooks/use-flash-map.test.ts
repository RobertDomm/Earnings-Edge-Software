import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFlashMap } from "./use-flash-map";

// Use fake timers throughout so we can control setTimeout
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeStocks(entries: Array<[string, number]>) {
  return entries.map(([symbol, price]) => ({ symbol, price }));
}

describe("useFlashMap", () => {
  it("adds a flash entry for a qualifying price increase", () => {
    const initial = makeStocks([["AAPL", 100]]);
    const { result, rerender } = renderHook(
      ({ stocks }) => useFlashMap(stocks, 0.001, 1500),
      { initialProps: { stocks: initial } },
    );

    // Baseline — no flash yet (first render has no previous price)
    expect(result.current.size).toBe(0);

    // Price rises 0.2% — above threshold
    const updated = makeStocks([["AAPL", 100.2]]);
    rerender({ stocks: updated });

    expect(result.current.get("AAPL")?.direction).toBe("up");
    expect(result.current.get("AAPL")?.animKey).toBe(1);
  });

  it("adds a flash entry for a qualifying price decrease", () => {
    const { result, rerender } = renderHook(
      ({ stocks }) => useFlashMap(stocks, 0.001, 1500),
      { initialProps: { stocks: makeStocks([["TSLA", 200]]) } },
    );

    rerender({ stocks: makeStocks([["TSLA", 199.5]]) }); // −0.25%

    expect(result.current.get("TSLA")?.direction).toBe("down");
  });

  it("does not flash for a change below the threshold", () => {
    const { result, rerender } = renderHook(
      ({ stocks }) => useFlashMap(stocks, 0.001, 1500),
      { initialProps: { stocks: makeStocks([["NVDA", 100]]) } },
    );

    rerender({ stocks: makeStocks([["NVDA", 100.05]]) }); // 0.05% — below threshold

    expect(result.current.get("NVDA")).toBeUndefined();
  });

  it("clears a flash entry after the flash duration elapses", () => {
    const { result, rerender } = renderHook(
      ({ stocks }) => useFlashMap(stocks, 0.001, 1500),
      { initialProps: { stocks: makeStocks([["AAPL", 100]]) } },
    );

    rerender({ stocks: makeStocks([["AAPL", 100.5]]) }); // qualifies
    expect(result.current.get("AAPL")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(result.current.get("AAPL")).toBeUndefined();
  });

  it("preserves an active flash on symbol A when an unrelated non-qualifying update fires", () => {
    const initial = makeStocks([
      ["AAPL", 100],
      ["MSFT", 50],
    ]);
    const { result, rerender } = renderHook(
      ({ stocks }) => useFlashMap(stocks, 0.001, 1500),
      { initialProps: { stocks: initial } },
    );

    // AAPL qualifies; MSFT does not move
    rerender({
      stocks: makeStocks([
        ["AAPL", 100.5],
        ["MSFT", 50],
      ]),
    });
    expect(result.current.get("AAPL")?.direction).toBe("up");

    // MSFT ticks by a sub-threshold amount only — AAPL flash must survive
    rerender({
      stocks: makeStocks([
        ["AAPL", 100.5],   // same price — no qualifying delta
        ["MSFT", 50.01],   // 0.02% — below threshold
      ]),
    });

    expect(result.current.get("AAPL")?.direction).toBe("up");
  });

  it("increments animKey and resets the timer on a rapid same-direction flash", () => {
    const { result, rerender } = renderHook(
      ({ stocks }) => useFlashMap(stocks, 0.001, 1500),
      { initialProps: { stocks: makeStocks([["AAPL", 100]]) } },
    );

    // First qualifying change
    rerender({ stocks: makeStocks([["AAPL", 100.2]]) });
    expect(result.current.get("AAPL")?.animKey).toBe(1);

    // Advance time partway through the flash window
    act(() => { vi.advanceTimersByTime(800); });

    // Second qualifying same-direction change before first expires
    rerender({ stocks: makeStocks([["AAPL", 100.5]]) });

    // animKey must increment so the caller can trigger a DOM remount
    expect(result.current.get("AAPL")?.animKey).toBe(2);
    expect(result.current.get("AAPL")?.direction).toBe("up");

    // The timer was reset; flash should still be active at t=800+800=1600ms
    // (would have expired at t=800+700=1500ms under the old timer)
    act(() => { vi.advanceTimersByTime(800); });
    expect(result.current.get("AAPL")).toBeDefined();

    // And expires after the full 1.5 s from the second flash
    act(() => { vi.advanceTimersByTime(700); });
    expect(result.current.get("AAPL")).toBeUndefined();
  });
});
