import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FiltersPanel } from "@/components/filters-panel";
import type { FilterList } from "@workspace/api-client-react";

// ── Mock the API hook ─────────────────────────────────────────────────────────

vi.mock("@workspace/api-client-react", () => ({
  useGetScannerFilters: vi.fn(),
}));

import { useGetScannerFilters } from "@workspace/api-client-react";
const mockUseGetScannerFilters = useGetScannerFilters as ReturnType<typeof vi.fn>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FILTER_DATA: FilterList = {
  filters: [
    {
      name: "IV Rank",
      description: "30-day implied volatility rank ≥ 50",
      threshold: "≥ 50",
      implemented: true,
    },
    {
      name: "Liquidity",
      description: "Open interest ≥ 500",
      threshold: "≥ 500",
      implemented: true,
    },
    {
      name: "Spread Width",
      description: "Bid/ask spread ≤ 5%",
      threshold: "≤ 5%",
      implemented: true,
    },
  ],
};

function makeCounts(
  entries: [string, number][],
  total: number,
  bypassEntries: [string, number][] = [],
) {
  return {
    counts: new Map<string, number>(entries),
    bypassCounts: new Map<string, number>(bypassEntries),
    total,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FiltersPanel pass counts", () => {
  it("shows no count rows before any scan has run (null filterPassCounts)", () => {
    mockUseGetScannerFilters.mockReturnValue({ data: FILTER_DATA, isLoading: false, isError: false });

    render(<FiltersPanel filterPassCounts={null} />);

    // Filter names are visible
    expect(screen.getByText("IV Rank")).toBeInTheDocument();
    expect(screen.getByText("Liquidity")).toBeInTheDocument();
    // No "passed" counts shown yet
    expect(screen.queryByText(/passed/)).toBeNull();
  });

  it("shows correct X/Y counts for filters with mixed pass rates", () => {
    mockUseGetScannerFilters.mockReturnValue({ data: FILTER_DATA, isLoading: false, isError: false });

    const counts = makeCounts([
      ["IV Rank", 31],
      ["Liquidity", 45],
      // Spread Width intentionally absent → 0 passed
    ], 47);

    render(<FiltersPanel filterPassCounts={counts} />);

    expect(screen.getByText("31/47 passed")).toBeInTheDocument();
    expect(screen.getByText("45/47 passed")).toBeInTheDocument();
  });

  it("shows 0/total for a filter with zero stocks passing", () => {
    mockUseGetScannerFilters.mockReturnValue({ data: FILTER_DATA, isLoading: false, isError: false });

    const counts = makeCounts([
      ["IV Rank", 31],
      ["Liquidity", 45],
      // Spread Width has no entry → zero passes
    ], 47);

    render(<FiltersPanel filterPassCounts={counts} />);

    expect(screen.getByText("0/47 passed")).toBeInTheDocument();
  });

  it("shows 0/0 counts for an empty completed scan (scan ran but found no stocks)", () => {
    mockUseGetScannerFilters.mockReturnValue({ data: FILTER_DATA, isLoading: false, isError: false });

    // Scan completed with 0 stocks — all filters get 0/0
    const counts = makeCounts([], 0);

    render(<FiltersPanel filterPassCounts={counts} />);

    const zeroCounts = screen.getAllByText("0/0 passed");
    expect(zeroCounts).toHaveLength(FILTER_DATA.filters.length);
  });

  it("shows all filters as passed when every stock passes every filter", () => {
    mockUseGetScannerFilters.mockReturnValue({ data: FILTER_DATA, isLoading: false, isError: false });

    const counts = makeCounts([
      ["IV Rank", 10],
      ["Liquidity", 10],
      ["Spread Width", 10],
    ], 10);

    render(<FiltersPanel filterPassCounts={counts} />);

    const allPassed = screen.getAllByText("10/10 passed");
    expect(allPassed).toHaveLength(3);
  });

  it("shows 'bypassed by provider' when all stocks had a filter bypassed (ThetaData mode)", () => {
    mockUseGetScannerFilters.mockReturnValue({ data: FILTER_DATA, isLoading: false, isError: false });

    // Simulate ThetaData: IV Rank bypassed for all 20 stocks (no earnings data from provider)
    const counts = makeCounts(
      [["Liquidity", 15], ["Spread Width", 12]],
      20,
      [["IV Rank", 20]], // all 20 stocks had IV Rank bypassed
    );

    render(<FiltersPanel filterPassCounts={counts} />);

    expect(screen.getByText("20/20 bypassed by provider")).toBeInTheDocument();
    // The other filters still show genuine pass counts
    expect(screen.getByText("15/20 passed")).toBeInTheDocument();
    expect(screen.getByText("12/20 passed")).toBeInTheDocument();
    // The bypassed badge should be visible
    expect(screen.getByText("bypassed")).toBeInTheDocument();
  });

  it("shows mixed 'passed • bypassed' note when some stocks bypassed and some passed a filter", () => {
    mockUseGetScannerFilters.mockReturnValue({ data: FILTER_DATA, isLoading: false, isError: false });

    const counts = makeCounts(
      [["IV Rank", 5], ["Liquidity", 15]],
      20,
      [["IV Rank", 10]], // 10 bypassed, 5 genuinely passed → mixed
    );

    render(<FiltersPanel filterPassCounts={counts} />);

    expect(screen.getByText("5/20 passed • 10 bypassed ⚠")).toBeInTheDocument();
  });

  it("renders a loading skeleton while filter definitions are loading", () => {
    mockUseGetScannerFilters.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    const { container } = render(<FiltersPanel filterPassCounts={null} />);

    // Skeleton elements are present (animate-pulse spans)
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    // No filter names yet
    expect(screen.queryByText("IV Rank")).toBeNull();
  });

  it("renders an error message when filter definitions fail to load", () => {
    mockUseGetScannerFilters.mockReturnValue({ data: undefined, isLoading: false, isError: true });

    render(<FiltersPanel filterPassCounts={null} />);

    expect(screen.getByText(/Could not load filter definitions/)).toBeInTheDocument();
  });
});
