/**
 * ScannerStatusWidget
 *
 * Owns scanner state display and auto-refresh configuration.
 * Receives auto-scanner state from the parent so a single useAutoScanner
 * instance drives both this widget and the results table in the dashboard.
 */
import {
  useGetScannerResults,
  getGetScannerResultsQueryKey,
} from "@workspace/api-client-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import {
  Loader2,
  Play,
  RefreshCw,
  Activity,
  Pause,
  Zap,
  AlertTriangle,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCompactNumber } from "@/lib/formatters";
import { useTimeAgo } from "@/hooks/use-time-ago";
import type { AutoScannerState } from "@/hooks/use-auto-scanner";

interface ScannerStatusWidgetProps {
  autoScanner: AutoScannerState;
  intervalSeconds: number;
}

export function ScannerStatusWidget({
  autoScanner,
  intervalSeconds,
}: ScannerStatusWidgetProps) {
  const queryClient = useQueryClient();

  const {
    data: scannerState,
    isLoading,
    refetch,
    isFetching,
  } = useGetScannerResults({
    query: {
      queryKey: getGetScannerResultsQueryKey(),
      // Background-poll for status — auto-scan results arrive here after each run
      refetchInterval: 5000,
    },
  });

  const { runScanner, triggerManual, isAutoActive, isPausedForClosed } =
    autoScanner;

  const lastUpdatedAgo = useTimeAgo(scannerState?.lastScan?.dataAsOf ?? null);

  const statusStr = scannerState?.status || "idle";
  const isRunning = statusStr === "running" || runScanner.isPending;

  const statusColors: Record<
    string,
    "success" | "danger" | "warning" | "default"
  > = {
    idle: "default",
    running: "warning",
    complete: "success",
    error: "danger",
  };
  const badgeColor = statusColors[statusStr] || "default";

  const handleRunScanner = () => {
    triggerManual();
    // Also invalidate the results query so the status refreshes immediately
    queryClient.invalidateQueries({ queryKey: getGetScannerResultsQueryKey() });
  };

  const isServingCachedData =
    scannerState?.lastScan?.dataFreshness?.source === "cached";
  const cachedAt = scannerState?.lastScan?.dataFreshness?.timestamp;

  if (isLoading) {
    return (
      <Card className="rounded-[16px] dark:rounded-none overflow-hidden border-border/50 bg-card dark:bg-black/40 shadow-md shadow-black/10 dark:shadow-none">
        <CardContent className="p-4 flex items-center gap-4 animate-pulse">
          <div className="h-8 w-32 bg-muted/50 rounded-none" />
          <div className="h-4 w-48 bg-muted/50" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-[16px] dark:rounded-none overflow-hidden border-border bg-card dark:bg-black/40 shadow-md shadow-black/10 dark:shadow-none backdrop-blur-sm relative overflow-hidden flex-1">
      <div className="absolute top-0 left-0 w-1 h-full bg-primary/50" />

      {isServingCachedData && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-400/60 text-amber-700 dark:bg-amber-950/60 dark:border-amber-600/40 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="text-[11px] font-mono uppercase tracking-wider">
            Market data API unreachable — showing cached data
            {cachedAt ? ` from ${new Date(cachedAt).toLocaleTimeString()}` : ""}
            . Results may be stale.
          </span>
        </div>
      )}

      <CardContent className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* ── Left: Run button + engine status ── */}
        <div className="flex items-center gap-4">
          <Button
            onClick={handleRunScanner}
            disabled={isRunning}
            className="rounded-lg dark:rounded-none font-mono uppercase tracking-wider h-10 px-6 bg-blue-950 hover:bg-blue-900 border-blue-950/50 dark:bg-primary dark:hover:bg-primary/90 dark:border-primary/50 text-white dark:text-primary-foreground transition-all border shrink-0"
          >
            {isRunning ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4 fill-current" />
            )}
            Run Scanner
          </Button>

          <div className="flex flex-col gap-1 border-l border-border pl-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
                Engine
              </span>

              <Badge
                variant={badgeColor}
                className="uppercase font-mono text-[10px] tracking-wider rounded-none px-1.5 py-0 flex items-center gap-1"
              >
                {isRunning && <Activity className="h-3 w-3 animate-pulse" />}
                {statusStr}
              </Badge>

              {/* Auto-refresh indicator */}
              {isAutoActive && (
                <Badge
                  variant="default"
                  className="font-mono text-[10px] tracking-wider rounded-none px-1.5 py-0 flex items-center gap-1 bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-400 border-transparent"
                >
                  <Zap className="h-2.5 w-2.5" />
                  AUTO {intervalSeconds}s
                </Badge>
              )}

              {isPausedForClosed && (
                <Badge
                  variant="default"
                  className="font-mono text-[10px] tracking-wider rounded-none px-1.5 py-0 flex items-center gap-1 bg-muted/50 text-muted-foreground border-transparent"
                >
                  <Pause className="h-2.5 w-2.5" />
                  PAUSED
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground mt-1">
              {scannerState?.lastScan ? (
                <>
                  <span>
                    Scanned:{" "}
                    <span className="text-foreground">
                      {formatCompactNumber(scannerState.lastScan.totalScanned)}
                    </span>
                  </span>
                  <span>
                    Passed:{" "}
                    <span className="text-up">
                      {formatCompactNumber(
                        scannerState.lastScan.totalQualified
                      )}
                    </span>
                  </span>
                </>
              ) : (
                <span>No scan history — run scanner to begin</span>
              )}
            </div>
          </div>
        </div>

        {/* ── Right: Last updated + refresh ── */}
        <div className="flex items-center gap-3 md:ml-auto">
          {/* Timestamps */}
          <div className="flex flex-col text-right text-xs font-mono text-muted-foreground">
            {lastUpdatedAgo ? (
              <>
                <span className="text-white font-bold dark:text-foreground/80 dark:font-normal">
                  Updated{" "}
                  <span className="text-white font-bold dark:text-cyan-400 dark:font-semibold">
                    {lastUpdatedAgo}
                  </span>
                </span>
                <span className="text-white font-bold dark:text-inherit dark:font-normal dark:opacity-70 text-[10px]">
                  Auto Refresh: {intervalSeconds} sec
                </span>
                {scannerState?.lastScan?.scanTime && (
                  <span className="text-white font-bold dark:text-inherit dark:font-normal dark:opacity-50 text-[10px]">
                    Scan:{" "}
                    {new Date(
                      scannerState.lastScan.scanTime
                    ).toLocaleTimeString()}
                  </span>
                )}
              </>
            ) : (
              <span>Not yet scanned</span>
            )}
          </div>

          {/* Manual refresh button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-8 w-8 rounded-lg dark:rounded-none hover:bg-muted/50 shrink-0"
            title="Refresh status"
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
