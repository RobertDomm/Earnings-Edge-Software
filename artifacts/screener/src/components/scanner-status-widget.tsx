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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Loader2,
  Play,
  RefreshCw,
  Activity,
  Pause,
  Zap,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCompactNumber } from "@/lib/formatters";
import { useTimeAgo } from "@/hooks/use-time-ago";
import type { AutoScannerState } from "@/hooks/use-auto-scanner";

export type AutoRefreshIntervalOption = 0 | 15 | 30 | 60 | 300;

interface ScannerStatusWidgetProps {
  autoScanner: AutoScannerState;
  intervalSeconds: AutoRefreshIntervalOption;
  onIntervalChange: (next: AutoRefreshIntervalOption) => void;
}

const INTERVAL_OPTIONS: { value: AutoRefreshIntervalOption; label: string }[] = [
  { value: 0, label: "Manual" },
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
  { value: 60, label: "1m" },
  { value: 300, label: "5m" },
];

export function ScannerStatusWidget({
  autoScanner,
  intervalSeconds,
  onIntervalChange,
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

  if (isLoading) {
    return (
      <Card className="rounded-none border-border/50 bg-black/40 shadow-none">
        <CardContent className="p-4 flex items-center gap-4 animate-pulse">
          <div className="h-8 w-32 bg-muted/50 rounded-none" />
          <div className="h-4 w-48 bg-muted/50" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-none border-border bg-black/40 shadow-none backdrop-blur-sm relative overflow-hidden flex-1">
      <div className="absolute top-0 left-0 w-1 h-full bg-primary/50" />

      <CardContent className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* ── Left: Run button + engine status ── */}
        <div className="flex items-center gap-4">
          <Button
            onClick={handleRunScanner}
            disabled={isRunning}
            className="rounded-none font-mono uppercase tracking-wider h-10 px-6 bg-primary text-primary-foreground hover:bg-primary/90 transition-all border border-primary/50 shrink-0"
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
                  className="font-mono text-[10px] tracking-wider rounded-none px-1.5 py-0 flex items-center gap-1 bg-cyan-500/15 text-cyan-400 border-transparent"
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
                    Qualified:{" "}
                    <span className="text-emerald-500">
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

        {/* ── Right: Last updated + interval selector ── */}
        <div className="flex items-center gap-3 md:ml-auto">
          {/* Timestamps */}
          <div className="flex flex-col text-right text-xs font-mono text-muted-foreground">
            {lastUpdatedAgo ? (
              <>
                <span className="text-foreground/80">
                  Updated{" "}
                  <span className="text-cyan-400 font-semibold">
                    {lastUpdatedAgo}
                  </span>
                </span>
                {scannerState?.lastScan?.scanTime && (
                  <span className="opacity-50 text-[10px]">
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
            className="h-8 w-8 rounded-none hover:bg-muted/50 shrink-0"
            title="Refresh status"
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
          </Button>

          {/* Auto-refresh interval selector */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest text-right">
              Auto-refresh
            </span>
            <Select
              value={String(intervalSeconds)}
              onValueChange={(v) =>
                onIntervalChange(Number(v) as AutoRefreshIntervalOption)
              }
            >
              <SelectTrigger className="h-7 w-[72px] rounded-none font-mono text-[11px] border-border bg-black/40 px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="rounded-none border-border font-mono text-xs">
                {INTERVAL_OPTIONS.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={String(opt.value)}
                    className="font-mono text-xs"
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
