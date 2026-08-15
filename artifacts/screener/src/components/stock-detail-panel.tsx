import { useGetStockDetail, getGetStockDetailQueryKey, StockResult } from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Loader2, TrendingUp, TrendingDown, Info, ShieldAlert, Activity } from "lucide-react";
import { formatCurrency, formatPercent, formatCompactNumber } from "@/lib/formatters";
import { Badge } from "./ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { ScrollArea } from "@radix-ui/react-scroll-area";
import { EarningsSourceBadge } from "./results-table";

// ── Filter 6 helper ──────────────────────────────────────────────────────────

interface Filter6Data {
  callStrike: string;
  putStrike: string;
  callPeak: string;
  putPeak: string;
}

function getFilter6Data(stock: StockResult): Filter6Data | null {
  // Show trade setup only for stocks that fully qualified
  if (!stock.qualified) return null;
  const f6 = stock.filterResults.find((fr) => fr.name.startsWith("Filter 6"));
  if (!f6 || !f6.passed) return null;

  const peakMatch = f6.calculatedValue.match(
    /([+\-]\$[\d.]+)\s+call\s*\/\s*([+\-]\$[\d.]+)\s+put/
  );
  const strikeMatch = f6.explanation.match(
    /([\d.]+)\s+call:.*?([\d.]+)\s+put:/
  );

  if (!peakMatch || !strikeMatch) return null;

  return {
    callStrike: strikeMatch[1],
    putStrike: strikeMatch[2],
    callPeak: peakMatch[1],
    putPeak: peakMatch[2],
  };
}

interface StockDetailPanelProps {
  symbol: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StockDetailPanel({ symbol, open, onOpenChange }: StockDetailPanelProps) {
  const { data: detail, isLoading, error } = useGetStockDetail(symbol || "", {
    query: {
      queryKey: getGetStockDetailQueryKey(symbol || ""),
      enabled: !!symbol,
    }
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:w-3/4 md:max-w-2xl border-l-border bg-background/95 backdrop-blur p-0 flex flex-col rounded-l-none gap-0">
        
        {isLoading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="font-mono text-xs uppercase tracking-wider">Loading {symbol}...</span>
            </div>
          </div>
        )}

        {error && !isLoading && (
          <div className="flex-1 flex items-center justify-center p-6 text-center text-red-400">
            <div className="flex flex-col items-center gap-2">
              <ShieldAlert className="h-8 w-8 mb-2 opacity-50" />
              <span className="font-mono text-sm uppercase tracking-wider">Failed to load data for {symbol}</span>
            </div>
          </div>
        )}

        {detail && !isLoading && (
          <>
            <div className="p-6 pb-4 border-b border-border bg-muted/10 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-primary/20" />
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h2 className="text-3xl font-mono font-bold tracking-tight text-foreground flex items-center gap-3">
                    {detail.stock.symbol}
                    <Badge variant={detail.stock.status === "qualified" ? "success" : "danger"} className="font-mono text-[10px] uppercase tracking-wider rounded-none px-2 py-0.5">
                      {detail.stock.status.replace("_", " ")}
                    </Badge>
                  </h2>
                  <p className="text-sm text-muted-foreground max-w-[300px] truncate" title={detail.stock.company}>
                    {detail.stock.company}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-mono font-semibold">
                    {formatCurrency(detail.stock.price)}
                  </div>
                  <div className={`flex items-center justify-end font-mono text-sm ${detail.stock.dailyChangePercent > 0 ? "text-emerald-500" : detail.stock.dailyChangePercent < 0 ? "text-red-500" : ""}`}>
                    {detail.stock.dailyChangePercent > 0 ? <TrendingUp className="mr-1 h-3 w-3" /> : detail.stock.dailyChangePercent < 0 ? <TrendingDown className="mr-1 h-3 w-3" /> : null}
                    {formatPercent(detail.stock.dailyChangePercent)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-4 mt-6">
                <Metric label="Volume" value={formatCompactNumber(detail.stock.volume)} />
                <Metric label="Avg Vol" value={formatCompactNumber(detail.stock.avgVolume)} />
                <Metric label="Mkt Cap" value={formatCompactNumber(detail.stock.marketCap)} />
                <Metric label="IV" value={`${(detail.stock.impliedVolatility * 100).toFixed(1)}%`} />
              </div>

              <div className="mt-4">
                <Metric
                  label="Next Earnings"
                  value={
                    detail.stock.nextEarningsDate ? (
                      <span className="inline-flex items-center gap-2">
                        {detail.stock.nextEarningsDate}
                        <EarningsSourceBadge source={detail.stock.earningsDateSource} />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Unknown</span>
                    )
                  }
                />
              </div>
            </div>

            <div className="flex-1 flex flex-col min-h-0">
              <Tabs defaultValue="overview" className="flex-1 flex flex-col h-full">
                <div className="px-6 pt-2 border-b border-border">
                  <TabsList className="bg-transparent space-x-4">
                    <TabsTrigger value="overview" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none pb-2 px-1 font-mono text-xs uppercase tracking-wider">Overview</TabsTrigger>
                    <TabsTrigger value="options" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none pb-2 px-1 font-mono text-xs uppercase tracking-wider">Options Chain</TabsTrigger>
                    <TabsTrigger value="filters" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none pb-2 px-1 font-mono text-xs uppercase tracking-wider">Filter Breakdown</TabsTrigger>
                  </TabsList>
                </div>
                
                <div className="flex-1 overflow-auto bg-muted/20 dark:bg-black/20 p-6">
                  <TabsContent value="overview" className="mt-0 h-full">
                    <div className="space-y-6">
                      {/* Trade setup callout — only shown for qualifying stocks with F6 data */}
                      {(() => {
                        const f6 = getFilter6Data(detail.stock);
                        if (!f6) return null;
                        return (
                          <div className="border border-emerald-500/30 bg-emerald-500/5 p-4 relative overflow-hidden">
                            <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500/60" />
                            <div className="pl-3">
                              <div className="flex items-center gap-2 mb-3">
                                <Activity className="h-3.5 w-3.5 text-emerald-500" />
                                <h3 className="text-[10px] font-mono text-emerald-500 uppercase tracking-wider">
                                  Double Calendar Setup
                                </h3>
                              </div>
                              <div className="grid grid-cols-2 gap-6">
                                <div className="space-y-3">
                                  <div>
                                    <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider block mb-1">Strikes</span>
                                    <span className="font-mono text-lg font-bold text-foreground">
                                      {f6.callStrike}c&nbsp;/&nbsp;{f6.putStrike}p
                                    </span>
                                  </div>
                                </div>
                                <div className="space-y-3">
                                  <div>
                                    <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider block mb-1">Peak P&amp;L</span>
                                    <span className="font-mono text-lg font-bold text-emerald-500">
                                      {f6.callPeak}&nbsp;/&nbsp;{f6.putPeak}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <p className="text-[10px] font-mono text-muted-foreground mt-3">
                                Short 11 DTE · Long 18 DTE · Both risk-graph peaks above zero
                              </p>
                            </div>
                          </div>
                        );
                      })()}

                      <div>
                        <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-3">Options Activity</h3>
                        <div className="grid grid-cols-2 gap-4">
                          <Metric label="Total Options Vol" value={formatCompactNumber(detail.stock.optionsVolume)} />
                          <Metric label="Total Open Interest" value={formatCompactNumber(detail.stock.openInterest)} />
                        </div>
                      </div>
                      
                      <div>
                        <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-3">Screener Score</h3>
                        <div className="flex items-center gap-4 border border-border p-4 bg-muted/5">
                          <div className="text-4xl font-mono text-primary font-light">
                            {detail.stock.filterScore.toFixed(1)}
                          </div>
                          <p className="text-sm text-muted-foreground max-w-sm">
                            Aggregate score based on implied volatility rank, volume unusualness, and technical setup.
                          </p>
                        </div>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="options" className="mt-0 h-full flex flex-col">
                    <div className="flex items-center justify-between mb-4">
                       <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Near-term Contracts</h3>
                    </div>
                    <div className="border border-border overflow-auto flex-1">
                      <Table className="w-full text-xs">
                        <TableHeader className="bg-muted/30 sticky top-0">
                          <TableRow className="hover:bg-transparent border-none">
                            <TableHead className="text-center w-[60px]" colSpan={4}>CALLS</TableHead>
                            <TableHead className="text-center font-bold text-foreground border-x border-border/50">STRIKE</TableHead>
                            <TableHead className="text-center w-[60px]" colSpan={4}>PUTS</TableHead>
                          </TableRow>
                          <TableRow className="hover:bg-transparent border-none">
                            <TableHead className="text-right">Vol</TableHead>
                            <TableHead className="text-right">OI</TableHead>
                            <TableHead className="text-right">Bid</TableHead>
                            <TableHead className="text-right">Ask</TableHead>
                            <TableHead className="text-center border-x border-border/50"></TableHead>
                            <TableHead className="text-right">Bid</TableHead>
                            <TableHead className="text-right">Ask</TableHead>
                            <TableHead className="text-right">Vol</TableHead>
                            <TableHead className="text-right">OI</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody className="divide-y divide-border/50">
                          {detail.optionsChain.contracts.map((c, i) => (
                            <TableRow key={i} className="hover:bg-muted/20 border-none font-mono text-[11px]">
                              <TableCell className="text-right text-muted-foreground">{c.callVolume}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{c.callOI}</TableCell>
                              <TableCell className="text-right">{c.callBid.toFixed(2)}</TableCell>
                              <TableCell className="text-right">{c.callAsk.toFixed(2)}</TableCell>
                              
                              <TableCell className="text-center font-bold text-foreground bg-muted/10 border-x border-border/50">
                                {c.strike.toFixed(1)}
                              </TableCell>
                              
                              <TableCell className="text-right">{c.putBid.toFixed(2)}</TableCell>
                              <TableCell className="text-right">{c.putAsk.toFixed(2)}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{c.putVolume}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{c.putOI}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </TabsContent>

                  <TabsContent value="filters" className="mt-0 h-full">
                    <div className="space-y-4">
                      {detail.stock.filterResults.map((fr, i) => (
                        <div key={i} className="border border-border bg-muted/20 dark:bg-black/20 p-4">
                          <div className="flex justify-between items-center mb-2">
                            <div className="flex items-center gap-3">
                              <Badge
                                variant={fr.passed ? "success" : "danger"}
                                className="font-mono text-[10px] uppercase tracking-wider rounded-none px-1.5 py-0"
                              >
                                {fr.passed ? "PASS" : "FAIL"}
                              </Badge>
                              <h4 className="font-mono text-sm font-semibold">{fr.name}</h4>
                            </div>
                            <div className="text-right font-mono text-xs">
                              <span className="text-muted-foreground mr-2">Target: {fr.threshold}</span>
                              <span className={fr.passed ? "text-emerald-500" : "text-red-500"}>Value: {fr.calculatedValue}</span>
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground flex items-start gap-2 mt-3 bg-muted/10 p-2 border-l-2 border-border/50">
                            <Info className="h-3 w-3 mt-0.5 opacity-50 shrink-0" />
                            <p>{fr.explanation}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </TabsContent>
                </div>
              </Tabs>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Metric({ label, value }: { label: string, value: string | React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className="text-sm font-mono text-foreground font-semibold">{value}</span>
    </div>
  );
}
