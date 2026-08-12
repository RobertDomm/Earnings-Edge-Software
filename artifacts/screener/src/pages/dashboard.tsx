import { useState, useMemo } from "react";
import { useRequireAuth } from "@/hooks/use-require-auth";
import { MarketStatusWidget } from "@/components/market-status-widget";
import { ScannerStatusWidget, type AutoRefreshIntervalOption } from "@/components/scanner-status-widget";
import { FiltersPanel } from "@/components/filters-panel";
import { ResultsTable } from "@/components/results-table";
import { useAutoScanner } from "@/hooks/use-auto-scanner";
import {
  useGetScannerResults,
  useGetMarketStatus,
  useLogout,
  getGetScannerResultsQueryKey,
  getGetMarketStatusQueryKey,
} from "@workspace/api-client-react";
import { LogOut, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

// ── Auto-refresh interval ────────────────────────────────────────────────────

const DEFAULT_INTERVAL: AutoRefreshIntervalOption = 30;
const INTERVAL_STORAGE_KEY = "screener:auto-refresh-interval";
const VALID_INTERVALS = new Set<number>([0, 15, 30, 60, 300]);

function readStoredInterval(): AutoRefreshIntervalOption {
  try {
    const raw = localStorage.getItem(INTERVAL_STORAGE_KEY);
    if (raw === null) return DEFAULT_INTERVAL;
    const parsed = Number(raw);
    return VALID_INTERVALS.has(parsed) ? (parsed as AutoRefreshIntervalOption) : DEFAULT_INTERVAL;
  } catch {
    return DEFAULT_INTERVAL;
  }
}

function writeStoredInterval(value: AutoRefreshIntervalOption): void {
  try { localStorage.setItem(INTERVAL_STORAGE_KEY, String(value)); } catch { /* ignore */ }
}

// ── Flash threshold ──────────────────────────────────────────────────────────

export type FlashThresholdOption = 0.001 | 0.0025 | 0.005 | 0.01 | 0.02;

const DEFAULT_THRESHOLD: FlashThresholdOption = 0.001;
const THRESHOLD_STORAGE_KEY = "screener:flash-threshold";
const VALID_THRESHOLDS = new Set<number>([0.001, 0.0025, 0.005, 0.01, 0.02]);

function readStoredThreshold(): FlashThresholdOption {
  try {
    const raw = localStorage.getItem(THRESHOLD_STORAGE_KEY);
    if (raw === null) return DEFAULT_THRESHOLD;
    const parsed = Number(raw);
    return VALID_THRESHOLDS.has(parsed) ? (parsed as FlashThresholdOption) : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}

function writeStoredThreshold(value: FlashThresholdOption): void {
  try { localStorage.setItem(THRESHOLD_STORAGE_KEY, String(value)); } catch { /* ignore */ }
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { auth } = useRequireAuth();
  const [_, setLocation] = useLocation();

  const [intervalSeconds, setIntervalSeconds] =
    useState<AutoRefreshIntervalOption>(readStoredInterval);

  const handleIntervalChange = (next: AutoRefreshIntervalOption) => {
    writeStoredInterval(next);
    setIntervalSeconds(next);
  };

  const [flashThreshold, setFlashThreshold] =
    useState<FlashThresholdOption>(readStoredThreshold);

  const handleFlashThresholdChange = (next: FlashThresholdOption) => {
    writeStoredThreshold(next);
    setFlashThreshold(next);
  };

  const { data: marketStatus } = useGetMarketStatus({
    query: {
      queryKey: getGetMarketStatusQueryKey(),
      refetchInterval: 60_000,
    },
  });

  const autoScanner = useAutoScanner({
    marketState: marketStatus?.state,
    intervalSeconds,
    enabled: !!auth?.authorized,
  });

  const { data: scannerState, isLoading } = useGetScannerResults({
    query: {
      queryKey: getGetScannerResultsQueryKey(),
      enabled: !!auth?.authorized,
      refetchInterval: 5_000,
    },
  });

  const logoutMutation = useLogout();

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => setLocation("/access-restricted"),
    });
  };

  // Derive per-filter pass counts from the last scan's filterResults.
  // Must be declared before any conditional return to preserve hook order.
  const filterPassCounts = useMemo(() => {
    const lastScan = scannerState?.lastScan;
    if (!lastScan) return null; // no scan run yet
    const total = lastScan.stocks.length;
    const counts = new Map<string, number>();
    for (const stock of lastScan.stocks) {
      for (const fr of stock.filterResults) {
        if (fr.passed) {
          counts.set(fr.name, (counts.get(fr.name) ?? 0) + 1);
        }
      }
    }
    return { counts, total };
  }, [scannerState?.lastScan]);

  if (!auth?.authorized) return null;

  const stocks = scannerState?.lastScan?.stocks || [];

  return (
    <div className="min-h-screen bg-background flex flex-col font-sans relative overflow-hidden">
      <div className="absolute inset-0 z-0 opacity-10 pointer-events-none">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />
      </div>

      <header className="border-b border-border bg-card/80 backdrop-blur-md z-10 sticky top-0 h-14 flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <TerminalSquare className="h-5 w-5 text-primary" />
          <h1 className="font-mono font-bold tracking-widest text-sm uppercase text-foreground">
            Circle Screener{" "}
            <span className="text-muted-foreground opacity-50 ml-2">v0.1.0</span>
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider hidden sm:inline-block">
            {auth.user?.email || "AUTHORIZED USER"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
            className="h-8 rounded-none font-mono text-xs uppercase hover:bg-destructive/20 hover:text-destructive transition-colors"
          >
            <LogOut className="h-4 w-4 mr-2" />
            Disconnect
          </Button>
        </div>
      </header>

      <main className="flex-1 p-6 flex flex-col gap-6 z-10 max-w-[1600px] mx-auto w-full">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-1">
            <MarketStatusWidget />
          </div>
          <div className="lg:col-span-3">
            <ScannerStatusWidget
              autoScanner={autoScanner}
              intervalSeconds={intervalSeconds}
              onIntervalChange={handleIntervalChange}
              flashThreshold={flashThreshold}
              onFlashThresholdChange={handleFlashThresholdChange}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 flex-1 min-h-0">
          <div className="lg:col-span-1 flex flex-col gap-6">
            <FiltersPanel filterPassCounts={filterPassCounts} />
          </div>
          <div className="lg:col-span-4 flex flex-col min-h-0">
            {isLoading ? (
              <div className="flex-1 border border-border bg-black/20 flex flex-col items-center justify-center min-h-[400px]">
                <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4" />
                <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">
                  Awaiting Engine Data...
                </span>
              </div>
            ) : (
              <ResultsTable stocks={stocks} flashThreshold={flashThreshold} />
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-border bg-card z-10 py-3 px-6">
        <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider text-center">
          For informational and educational purposes only. This tool does not
          constitute financial advice.
        </p>
      </footer>
    </div>
  );
}
