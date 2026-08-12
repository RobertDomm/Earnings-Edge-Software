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

interface ResultsTableProps {
  stocks: StockResult[];
  /** Relative price-change fraction that triggers a flash highlight (default 0.001 = 0.1%) */
  flashThreshold?: number;
}

type SortKey = keyof StockResult;
type SortOrder = "asc" | "desc" | null;

export function ResultsTable({ stocks, flashThreshold = 0.001 }: ResultsTableProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "qualified" | "not_qualified">("all");
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
      const matchesStatus = statusFilter === "all" || s.status === statusFilter;
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
              <SelectItem value="all" className="font-mono text-xs">All Statuses</SelectItem>
              <SelectItem value="qualified" className="font-mono text-xs">Qualified Only</SelectItem>
              <SelectItem value="not_qualified" className="font-mono text-xs">Not Qualified</SelectItem>
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
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-border/50">
              {filteredStocks.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={12} className="h-32 text-center text-muted-foreground font-mono text-sm">
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
                      <TableCell className="font-mono text-right px-3 py-2.5">
                        {formatCurrency(stock.price)}
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
                        <Badge 
                          variant={stock.status === "qualified" ? "success" : "danger"}
                          className="font-mono text-[10px] uppercase tracking-wider rounded-none px-1.5 py-0"
                        >
                          {stock.status.replace("_", " ")}
                        </Badge>
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
