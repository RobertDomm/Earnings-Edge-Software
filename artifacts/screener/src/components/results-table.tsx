import { useState, useMemo } from "react";
import { StockResult } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { formatCurrency, formatPercent, formatCompactNumber } from "@/lib/formatters";
import { Badge } from "./ui/badge";
import { Search, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { StockDetailPanel } from "./stock-detail-panel";
import { useFlashMap } from "@/hooks/use-flash-map";

// ── Filter 6 helper ──────────────────────────────────────────────────────────

interface Filter6Data {
  /** e.g. "207.5" */
  callStrike: string;
  /** e.g. "172.5" */
  putStrike: string;
  /** e.g. "+$1.24" */
  callPeak: string;
  /** e.g. "+$0.98" */
  putPeak: string;
}

/**
 * Extracts the Filter 6 (Double Calendar Structure) trade details from a
 * stock's filterResults. Returns null when the stock is not overall-qualified,
 * when Filter 6 did not pass, or when the expected values aren't present.
 *
 * calculatedValue format: "+$1.24 call  /  +$0.98 put"
 * explanation format:     "Both risk-graph peaks are above zero — 207.5 call: +$1.24; 172.5 put: +$0.98. …"
 */
function getFilter6Data(stock: StockResult): Filter6Data | null {
  // Only show trade setup for stocks that passed every filter
  if (!stock.qualified) return null;
  const f6 = stock.filterResults.find((fr) => fr.name.startsWith("Filter 6"));
  if (!f6 || !f6.passed) return null;

  // Extract P&Ls from calculatedValue
  const peakMatch = f6.calculatedValue.match(
    /([+\-]\$[\d.]+)\s+call\s*\/\s*([+\-]\$[\d.]+)\s+put/
  );
  // Extract strikes from explanation
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

interface ResultsTableProps {
  stocks: StockResult[];
  /** Relative price-change fraction that triggers a flash highlight (default 0.001 = 0.1%) */
  flashThreshold?: number;
}

type SortKey = keyof StockResult;
type SortOrder = "asc" | "desc" | null;

export function ResultsTable({ stocks, flashThreshold = 0.001 }: ResultsTableProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pass" | "partial">("all");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  // Per-symbol flash state. Each entry has an independent 1.5 s expiry timer so
  // that non-qualifying updates do not cancel active flashes on other symbols.
  // `animKey` is baked into the React `key` of each row so that a repeat flash
  // on the same symbol forces a DOM remount and restarts the CSS animation.
  const flashMap = useFlashMap(stocks, flashThreshold);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortOrder === "asc") setSortOrder("desc");
      else if (sortOrder === "desc") {
        setSortKey(null);
        setSortOrder(null);
      }
    } else {
      setSortKey(key);
      setSortOrder("asc");
    }
  };

  const filteredStocks = useMemo(() => {
    return stocks.filter(s => {
      const matchesSearch = s.symbol.toLowerCase().includes(search.toLowerCase()) || 
                            s.company.toLowerCase().includes(search.toLowerCase());
      const isPartialPass = s.status !== "qualified" && (s.filterResults?.[0]?.passed ?? false);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "pass" && s.status === "qualified") ||
        (statusFilter === "partial" && isPartialPass);
      return matchesSearch && matchesStatus;
    }).sort((a, b) => {
      if (!sortKey || !sortOrder) return 0;
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      
      if (typeof aVal === "number" && typeof bVal === "number") {
        return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
      }
      
      const aStr = String(aVal).toLowerCase();
      const bStr = String(bVal).toLowerCase();
      if (aStr < bStr) return sortOrder === "asc" ? -1 : 1;
      if (aStr > bStr) return sortOrder === "asc" ? 1 : -1;
      return 0;
    });
  }, [stocks, search, statusFilter, sortKey, sortOrder]);

  const SortIcon = ({ columnKey }: { columnKey: SortKey }) => {
    if (sortKey !== columnKey) return <ArrowUpDown className="ml-1 h-3 w-3 opacity-30 group-hover:opacity-100" />;
    if (sortOrder === "asc") return <ArrowUp className="ml-1 h-3 w-3 text-primary" />;
    return <ArrowDown className="ml-1 h-3 w-3 text-primary" />;
  };

  const renderSortableHeader = (label: string, key: SortKey) => (
    <TableHead 
      className="cursor-pointer group select-none whitespace-nowrap text-xs font-mono font-normal uppercase tracking-wider h-10 px-3 py-2 bg-muted/30"
      onClick={() => handleSort(key)}
    >
      <div className="flex items-center">
        {label}
        <SortIcon columnKey={key} />
      </div>
    </TableHead>
  );

  return (
    <div className="flex flex-col gap-4 w-full h-full">
      <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search symbol or company..."
            className="pl-9 rounded-none font-mono text-xs border-border bg-black/40 h-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select value={statusFilter} onValueChange={(v: any) => setStatusFilter(v)}>
            <SelectTrigger className="rounded-none font-mono text-xs border-border bg-black/40 h-9">
              <SelectValue placeholder="Filter Status" />
            </SelectTrigger>
            <SelectContent className="rounded-none border-border">
              <SelectItem value="all" className="font-mono text-xs">All Status</SelectItem>
              <SelectItem value="pass" className="font-mono text-xs">Pass</SelectItem>
              <SelectItem value="partial" className="font-mono text-xs">Partial Pass</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border border-border bg-black/20 overflow-hidden flex-1 relative">
        <div className="overflow-auto max-h-[800px]">
          <Table className="w-full text-sm">
            <TableHeader className="sticky top-0 z-10 border-b border-border shadow-sm">
              <TableRow className="hover:bg-transparent border-none">
                {renderSortableHeader("Symbol", "symbol")}
                {renderSortableHeader("Company", "company")}
                {renderSortableHeader("Price", "price")}
                {renderSortableHeader("Change", "dailyChangePercent")}
                {renderSortableHeader("Vol", "volume")}
                {renderSortableHeader("Avg Vol", "avgVolume")}
                {renderSortableHeader("Mkt Cap", "marketCap")}
                {renderSortableHeader("IV", "impliedVolatility")}
                {renderSortableHeader("Opt Vol", "optionsVolume")}
                {renderSortableHeader("OI", "openInterest")}
                {renderSortableHeader("Score", "filterScore")}
                {renderSortableHeader("Status", "status")}
                <TableHead className="whitespace-nowrap text-xs font-mono font-normal uppercase tracking-wider h-10 px-3 py-2 bg-muted/30">
                  Setup
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-border/50">
              {filteredStocks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={13} className="h-32 text-center text-muted-foreground font-mono text-sm">
                    No results found
                  </TableCell>
                </TableRow>
              ) : (
                filteredStocks.map((stock) => {
                  const flash = flashMap.get(stock.symbol);
                  // Including animKey in the React key remounts the row when the same
                  // symbol flashes again, which restarts the CSS keyframe animation.
                  const rowKey = flash
                    ? `${stock.symbol}-${flash.animKey}`
                    : stock.symbol;
                  return (
                    <TableRow
                      key={rowKey}
                      className={`cursor-pointer hover:bg-muted/30 transition-colors group border-none${
                        flash?.direction === "up"
                          ? " row-flash-up"
                          : flash?.direction === "down"
                          ? " row-flash-down"
                          : ""
                      }`}
                      onClick={() => setSelectedSymbol(stock.symbol)}
                    >
                      <TableCell className="font-mono font-semibold text-primary px-3 py-2.5">
                        {stock.symbol}
                      </TableCell>
                      <TableCell className="max-w-[150px] truncate text-muted-foreground px-3 py-2.5" title={stock.company}>
                        {stock.company}
                      </TableCell>
                      <TableCell className="font-mono text-right px-3 py-2.5 relative">
                        {formatCurrency(stock.price)}
                        {flash && (
                          <span
                            key={flash.animKey}
                            className={`delta-badge absolute left-full top-1/2 -translate-y-1/2 ml-1 z-20 text-[10px] font-mono font-semibold px-1 py-0 leading-tight rounded-sm whitespace-nowrap pointer-events-none ${
                              flash.direction === "up"
                                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300"
                                : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
                            }`}
                          >
                            {flash.delta >= 0 ? "+" : ""}
                            {flash.delta.toFixed(2)}&nbsp;/&nbsp;
                            {flash.deltaPercent >= 0 ? "+" : ""}
                            {(flash.deltaPercent * 100).toFixed(2)}%
                          </span>
                        )}
                      </TableCell>
                      <TableCell className={`font-mono text-right px-3 py-2.5 ${stock.dailyChangePercent > 0 ? "text-emerald-500" : stock.dailyChangePercent < 0 ? "text-red-500" : ""}`}>
                        {formatPercent(stock.dailyChangePercent)}
                      </TableCell>
                      <TableCell className="font-mono text-right px-3 py-2.5">
                        {formatCompactNumber(stock.volume)}
                      </TableCell>
                      <TableCell className="font-mono text-right px-3 py-2.5 text-muted-foreground">
                        {formatCompactNumber(stock.avgVolume)}
                      </TableCell>
                      <TableCell className="font-mono text-right px-3 py-2.5 text-muted-foreground">
                        {formatCompactNumber(stock.marketCap)}
                      </TableCell>
                      <TableCell className="font-mono text-right px-3 py-2.5">
                        {(stock.impliedVolatility * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className="font-mono text-right px-3 py-2.5">
                        {formatCompactNumber(stock.optionsVolume)}
                      </TableCell>
                      <TableCell className="font-mono text-right px-3 py-2.5 text-muted-foreground">
                        {formatCompactNumber(stock.openInterest)}
                      </TableCell>
                      <TableCell className="font-mono text-right px-3 py-2.5">
                        {stock.filterScore.toFixed(2)}
                      </TableCell>
                      <TableCell className="px-3 py-2.5 text-center">
                        {(() => {
                          const isPartial = stock.status !== "qualified" && (stock.filterResults?.[0]?.passed ?? false);
                          const label = stock.status === "qualified" ? "Pass" : isPartial ? "Partial Pass" : "Failed";
                          const variant = stock.status === "qualified" ? "success" : isPartial ? "warning" : "danger";
                          return (
                            <Badge
                              variant={variant as any}
                              className="font-mono text-[10px] uppercase tracking-wider rounded-none px-1.5 py-0"
                            >
                              {label}
                            </Badge>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="px-3 py-2.5 min-w-[130px]">
                        {(() => {
                          const f6 = getFilter6Data(stock);
                          if (!f6) {
                            return <span className="font-mono text-xs text-muted-foreground/40">—</span>;
                          }
                          return (
                            <div className="flex flex-col gap-0.5">
                              <span className="font-mono text-[11px] font-semibold text-foreground whitespace-nowrap">
                                {f6.callStrike}c&nbsp;/&nbsp;{f6.putStrike}p
                              </span>
                              <span className="font-mono text-[10px] text-emerald-500 whitespace-nowrap">
                                {f6.callPeak}&nbsp;/&nbsp;{f6.putPeak}
                              </span>
                            </div>
                          );
                        })()}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <StockDetailPanel 
        symbol={selectedSymbol} 
        open={!!selectedSymbol} 
        onOpenChange={(open) => {
          if (!open) setSelectedSymbol(null);
        }} 
      />
    </div>
  );
}
