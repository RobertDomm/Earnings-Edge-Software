import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResultsTable } from "@/components/results-table";
import type { StockResult } from "@workspace/api-client-react";

// Stub the slide-over panel — it renders query-dependent content not under test
vi.mock("@/components/stock-detail-panel", () => ({
  StockDetailPanel: () => null,
}));

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeStock(price: number, symbol = "AAPL"): StockResult {
  return {
    symbol,
    company: "Apple Inc.",
    price,
    dailyChangePercent: 0.5,
    volume: 1_000_000,
    avgVolume: 900_000,
    marketCap: 3_000_000_000_000,
    impliedVolatility: 0.25,
    optionsVolume: 50_000,
    openInterest: 100_000,
    filterScore: 0.85,
    status: "qualified",
    qualified: true,
    filterResults: [],
  };
}

/** Wrap the table in a QueryClientProvider so child components can call hooks. */
function buildTree(
  stocks: StockResult[],
  threshold: number,
  client: QueryClient,
) {
  return (
    <QueryClientProvider client={client}>
      <ResultsTable stocks={stocks} flashThreshold={threshold} />
    </QueryClientProvider>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ResultsTable delta badge", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a delta badge when the price rises above the flash threshold", () => {
    const { rerender } = render(buildTree([makeStock(100)], 0.001, queryClient));

    // 100 → 100.5 is +0.5% — well above the 0.1% threshold
    rerender(buildTree([makeStock(100.5)], 0.001, queryClient));

    const badge = document.querySelector(".delta-badge");
    expect(badge).not.toBeNull();
    // Shows absolute delta and percent change
    expect(badge?.textContent).toMatch(/\+0\.50/);
    expect(badge?.textContent).toMatch(/\+0\.50%/);
  });

  it("shows a delta badge (negative) when the price falls below the threshold", () => {
    const { rerender } = render(buildTree([makeStock(100)], 0.001, queryClient));

    // 100 → 99.5 is −0.5% — qualifies
    rerender(buildTree([makeStock(99.5)], 0.001, queryClient));

    const badge = document.querySelector(".delta-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toMatch(/-0\.50/);
    expect(badge?.textContent).toMatch(/-0\.50%/);
  });

  it("does not show a delta badge when the change is below the threshold", () => {
    const { rerender } = render(buildTree([makeStock(100)], 0.001, queryClient));

    // 100 → 100.05 is +0.05% — below the 0.1% threshold
    rerender(buildTree([makeStock(100.05)], 0.001, queryClient));

    expect(document.querySelector(".delta-badge")).toBeNull();
  });

  it("removes the delta badge after the flash duration elapses", () => {
    const { rerender } = render(buildTree([makeStock(100)], 0.001, queryClient));

    // Trigger a qualifying flash
    rerender(buildTree([makeStock(100.5)], 0.001, queryClient));
    expect(document.querySelector(".delta-badge")).not.toBeNull();

    // Advance past the 1500 ms expiry
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(document.querySelector(".delta-badge")).toBeNull();
  });

  it("only flashes the qualifying symbol when two stocks are rendered", () => {
    const initial = [makeStock(100, "AAPL"), makeStock(50, "MSFT")];
    const { rerender } = render(buildTree(initial, 0.001, queryClient));

    // AAPL qualifies (+0.5%), MSFT stays flat
    rerender(
      buildTree(
        [makeStock(100.5, "AAPL"), makeStock(50, "MSFT")],
        0.001,
        queryClient,
      ),
    );

    // Exactly one badge — the one on AAPL's row
    const badges = document.querySelectorAll(".delta-badge");
    expect(badges.length).toBe(1);
    expect(badges[0]?.textContent).toMatch(/\+0\.50/);
  });
});
