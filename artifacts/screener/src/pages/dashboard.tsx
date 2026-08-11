import { useRequireAuth } from "@/hooks/use-require-auth";
import { MarketStatusWidget } from "@/components/market-status-widget";
import { ScannerStatusWidget } from "@/components/scanner-status-widget";
import { FiltersPanel } from "@/components/filters-panel";
import { ResultsTable } from "@/components/results-table";
import { useGetScannerResults, useLogout, getGetScannerResultsQueryKey } from "@workspace/api-client-react";
import { LogOut, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

export default function Dashboard() {
  const { auth } = useRequireAuth();
  const [_, setLocation] = useLocation();
  
  const { data: scannerState, isLoading } = useGetScannerResults({
    query: {
      queryKey: getGetScannerResultsQueryKey(),
      enabled: !!auth?.authorized,
    }
  });

  const logoutMutation = useLogout();

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        setLocation("/access-restricted");
      }
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
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>
      </div>

      <header className="border-b border-border bg-card/80 backdrop-blur-md z-10 sticky top-0 h-14 flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <TerminalSquare className="h-5 w-5 text-primary" />
          <h1 className="font-mono font-bold tracking-widest text-sm uppercase text-foreground">
            Circle Screener <span className="text-muted-foreground opacity-50 ml-2">v0.1.0</span>
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
             <ScannerStatusWidget />
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
                 <span className="font-mono text-xs text-muted-foreground uppercase tracking-wider">Awaiting Engine Data...</span>
               </div>
             ) : (
               <ResultsTable stocks={stocks} />
             )}
          </div>
        </div>

      </main>

      <footer className="border-t border-border bg-card z-10 py-3 px-6">
        <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider text-center">
          For informational and educational purposes only. This tool does not constitute financial advice.
        </p>
      </footer>
    </div>
  );
}