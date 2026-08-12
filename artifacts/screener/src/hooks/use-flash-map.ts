import { useState, useRef, useEffect } from "react";

export type FlashDirection = "up" | "down";
export interface FlashEntry {
  direction: FlashDirection;
  /** Increments each time this symbol re-flashes; used as part of React key to remount row */
  animKey: number;
}

/**
 * Tracks which symbols changed price by at least `threshold` (relative fraction)
 * since the last call and returns a per-symbol flash map.
 *
 * Each symbol's flash entry has an independent 1.5 s expiry timer so that:
 * - Unrelated `stocks` updates do not cancel active flashes.
 * - A repeat qualifying change for the same symbol resets its timer and bumps
 *   `animKey`, which callers put in the React `key` to force a DOM remount and
 *   restart the CSS animation.
 */
export function useFlashMap(
  stocks: ReadonlyArray<{ symbol: string; price: number }>,
  threshold = 0.001,
  flashDurationMs = 1500,
): Map<string, FlashEntry> {
  const prevPricesRef = useRef<Map<string, number>>(new Map());
  const [flashMap, setFlashMap] = useState<Map<string, FlashEntry>>(new Map());
  // Per-symbol expiry timers — independent of each other
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (stocks.length === 0) return;

    const prevPrices = prevPricesRef.current;
    const qualifying: Array<{ symbol: string; direction: FlashDirection }> = [];

    for (const stock of stocks) {
      const prev = prevPrices.get(stock.symbol);
      if (prev !== undefined && prev !== 0) {
        const delta = (stock.price - prev) / prev;
        if (Math.abs(delta) >= threshold) {
          qualifying.push({
            symbol: stock.symbol,
            direction: delta > 0 ? "up" : "down",
          });
        }
      }
    }

    // Always update previous prices, even when nothing qualifies
    prevPricesRef.current = new Map(stocks.map((s) => [s.symbol, s.price]));

    if (qualifying.length === 0) return;

    // Merge qualifying symbols into the existing flash map
    setFlashMap((prev) => {
      const next = new Map(prev);
      for (const { symbol, direction } of qualifying) {
        const existing = next.get(symbol);
        next.set(symbol, {
          direction,
          animKey: (existing?.animKey ?? 0) + 1,
        });
      }
      return next;
    });

    // Set/refresh a per-symbol expiry timer
    for (const { symbol } of qualifying) {
      const existing = timersRef.current.get(symbol);
      if (existing !== undefined) clearTimeout(existing);

      const timer = setTimeout(() => {
        setFlashMap((prev) => {
          const next = new Map(prev);
          next.delete(symbol);
          return next;
        });
        timersRef.current.delete(symbol);
      }, flashDurationMs);

      timersRef.current.set(symbol, timer);
    }
  }, [stocks, threshold, flashDurationMs]);

  // Clear all timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  return flashMap;
}
