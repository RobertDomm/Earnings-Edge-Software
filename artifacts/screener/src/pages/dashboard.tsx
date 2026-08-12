import { useState } from "react";
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

// Default polling interval — configurable per-session via the UI dropdown
const DEFAULT_INTERVAL: AutoRefreshIntervalOption = 30;

const STORAGE_KEY = "screener:auto-refresh-interval";
const VALID_INTERVALS = new Set<number>([0, 15, 30, 60, 300]);

function readStoredInterval(): AutoRefreshIntervalOption {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_INTERVAL;
    const parsed = Number(raw);
    return VALID_INTERVALS.has(parsed)
      ? (parsed as AutoRefreshIntervalOption)
      : DEFAULT_INTERVAL;
  } catch {
    // localStorage unavailable (e.g. private-browsing restrictions)
    return DEFAULT_INTERVAL;
  }
}

function writeStoredInterval(value: AutoRefreshIntervalOption): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Silently ignore write failures
  }
}

export default function Dashboard() {
  const { auth } = useRequireAuth();
  const [_, setLocation] = useLocation();
  // Lazy initializer reads from localStorage; falls back to DEFAULT_INTERVAL
  // when no value is stored or the stored value is not a valid option.
  const [intervalSeconds, setIntervalSeconds] =
    useState<AutoRefreshIntervalOption>(readStoredInterval);

  const handleIntervalChange = (next: AutoRefreshIntervalOption) => {
    writeStoredInterval(next);
    setIntervalSeconds(next);
  };

  const { data: marketStatus } = useGetMarketStatus({
    query: {
      queryKey: getGetMarketStatusQueryKey(),
      // Market status drives polling behavior — poll every 60s to detect open/close transitions
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
      // Background poll for results — the auto-scanner invalidates this after each run,
      // and the 5s fallback poll catches any race conditions
      refetchInterval: 5_000,
    },
  });

  const logoutMutation = useLogout();

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        setLocation("/access-restricted");
      },
    });
  };

  if (!auth?.authorized) {
    return null; // Will redirect via useRequireAuth
  }

  const stocks = scannerState?.lastScan?.stocks || [];

  return (
    <div className="min-h-screen bg-background flex flex-col font-sans relative overflow-hidden">
      {/* Subtle grid background */}
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
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 flex-1 min-h-0">
          <div className="lg:col-span-1 flex flex-col gap-6">
            <FiltersPanel />
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
              <ResultsTable stocks={stocks} />
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
