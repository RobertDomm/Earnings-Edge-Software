import { useGetScannerResults, useRunScanner, getGetScannerResultsQueryKey } from "@workspace/api-client-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Loader2, Play, RefreshCw, ServerCrash, Activity } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCompactNumber } from "@/lib/formatters";

export function ScannerStatusWidget() {
  const queryClient = useQueryClient();
  const { data: scannerState, isLoading, refetch, isFetching } = useGetScannerResults({
    query: {
      queryKey: getGetScannerResultsQueryKey(),
      refetchInterval: 30000,
    }
  });

  const runScanner = useRunScanner();

  const handleRunScanner = () => {
    runScanner.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetScannerResultsQueryKey() });
      }
    });
  };

  if (isLoading) {
    return (
      <Card className="rounded-none border-border/50 bg-black/40 shadow-none">
        <CardContent className="p-4 flex items-center gap-4 animate-pulse">
          <div className="h-8 w-32 bg-muted/50 rounded-none"></div>
          <div className="h-4 w-48 bg-muted/50"></div>
        </CardContent>
      </Card>
    );
  }

  const statusColors: Record<string, "success" | "danger" | "warning" | "default"> = {
    idle: "default",
    running: "warning",
    complete: "success",
    error: "danger",
  };

  const statusStr = scannerState?.status || "idle";
  const badgeColor = statusColors[statusStr] || "default";

  return (
    <Card className="rounded-none border-border bg-black/40 shadow-none backdrop-blur-sm relative overflow-hidden flex-1">
      <div className="absolute top-0 left-0 w-1 h-full bg-primary/50" />
      <CardContent className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        
        <div className="flex items-center gap-4">
          <Button 
            onClick={handleRunScanner} 
            disabled={runScanner.isPending || statusStr === "running"}
            className="rounded-none font-mono uppercase tracking-wider h-10 px-6 bg-primary text-primary-foreground hover:bg-primary/90 transition-all border border-primary/50"
          >
            {runScanner.isPending || statusStr === "running" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4 fill-current" />
            )}
            Run Scanner
          </Button>

          <div className="flex flex-col gap-1 border-l border-border pl-4">
             <div className="flex items-center gap-2">
               <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Engine Status</span>
               <Badge variant={badgeColor} className="uppercase font-mono text-[10px] tracking-wider rounded-none px-1.5 py-0 flex items-center gap-1">
                 {statusStr === "running" && <Activity className="h-3 w-3 animate-pulse" />}
                 {statusStr}
               </Badge>
             </div>
             
             <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground mt-1">
                {scannerState?.lastScan ? (
                  <>
                    <span>Scanned: <span className="text-foreground">{formatCompactNumber(scannerState.lastScan.totalScanned)}</span></span>
                    <span>Qualified: <span className="text-foreground text-emerald-500">{formatCompactNumber(scannerState.lastScan.totalQualified)}</span></span>
                  </>
                ) : (
                  <span>No scan history</span>
                )}
             </div>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs font-mono text-muted-foreground border-l border-border pl-4 md:border-none md:pl-0">
          <div className="flex flex-col text-right">
            <span>Last Scan: {scannerState?.lastScanTime ? new Date(scannerState.lastScanTime).toLocaleTimeString() : 'Never'}</span>
            {scannerState?.lastScan?.dataAsOf && (
              <span className="opacity-70">Data as of: {new Date(scannerState.lastScan.dataAsOf).toLocaleTimeString()}</span>
            )}
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => refetch()} 
            disabled={isFetching}
            className="h-8 w-8 rounded-none hover:bg-muted/50"
            title="Refresh Status"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
