import { useState, useMemo } from "react";
import { StockResult } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { formatCurrency, formatPercent } from "@/lib/formatters";
import { Badge } from "./ui/badge";
import { Search, ArrowUpDown, ArrowUp, ArrowDown, CheckCircle2, XCircle } from "lucide-react";
import { StockDetailPanel } from "./stock-detail-panel";
import { useFlashMap } from "@/hooks/use-flash-map";

interface ResultsTableProps {
  stocks: StockResult[];
  /** Relative price-change fraction that triggers a flash highlight (default 0.001 = 0.1%) */
  flashThreshold?: number;
}

type SortKey = "symbol" | "company" | "price" | "dailyChangePercent" | "filterScore" | "status";
type SortOrder = "asc" | "desc" | null;

// Short labels shown in the column header (tooltip shows full filter name).
const FILTER_SHORT_LABELS = ["F1", "F2", "F3", "F4", "F5", "F6"];

export function ResultsTable({ stocks, flashThreshold = 0.001 }: ResultsTableProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pass" | "partial">("all");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);

  const flashMap = useFlashMap(stocks, flashThreshold);

  // Derive filter names from the first stock that has filterResults.
  // Falls back to generic labels if no data yet.
  const filterNames = useMemo<string[]>(() => {
    const first = stocks.find((s) => s.filterResults && s.filterResults.length > 0);
    if (!first) return FILTER_SHORT_LABELS.map((_, i) => `Filter ${i + 1}`);
    return first.filterResults.map((fr) => fr.name);
  }, [stocks]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortOrder === "asc") setSortOrder("desc");
      else if (sortOrder === "desc") { setSortKey(null); setSortOrder(null); }
    } else {
      setSortKey(key);
      setSortOrder("asc");
    }
  };

  const filteredStocks = useMemo(() => {
    return stocks
      .filter((s) => {
        const matchesSearch =
          s.symbol.toLowerCase().includes(search.toLowerCase()) ||
          s.company.toLowerCase().includes(search.toLowerCase());
        const isPartialPass =
          s.status !== "qualified" && (s.filterResults?.[0]?.passed ?? false);
        const matchesStatus =
          statusFilter === "all" ||
          (statusFilter === "pass" && s.status === "qualified") ||
          (statusFilter === "partial" && isPartialPass);
        return matchesSearch && matchesStatus;
      })
      .sort((a, b) => {
        if (!sortKey || !sortOrder) return 0;
        const aVal = a[sortKey as keyof StockResult];
        const bVal = b[sortKey as keyof StockResult];
        if (typeof aVal === "number" && typeof bVal === "number") {
          return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
        }
        const aStr = String(aVal ?? "").toLowerCase();
        const bStr = String(bVal ?? "").toLowerCase();
        if (aStr < bStr) return sortOrder === "asc" ? -1 : 1;
        if (aStr > bStr) return sortOrder === "asc" ? 1 : -1;
        return 0;
      });
  }, [stocks, search, statusFilter, sortKey, sortOrder]);

  const SortIcon = ({ columnKey }: { columnKey: SortKey }) => {
    if (sortKey !== columnKey)
      return <ArrowUpDown className="ml-1 h-3 w-3 opacity-30 group-hover:opacity-100" />;
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

  const renderFilterHeader = (index: number) => (
    <TableHead
      key={index}
      title={filterNames[index] ?? `Filter ${index + 1}`}
      className="text-center text-xs font-mono font-normal uppercase tracking-wider h-10 px-2 py-2 bg-muted/30 select-none w-10"
    >
      {FILTER_SHORT_LABELS[index]}
    </TableHead>
  );

  const numFilters = filterNames.length;
  // colSpan: Symbol + Company + Price + Change + filters + Score + Status
  const totalCols = 4 + numFilters + 2;

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
          <Select
            value={statusFilter}
            onValueChange={(v: "all" | "pass" | "partial") => setStatusFilter(v)}
          >
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
                {Array.from({ length: numFilters }, (_, i) => renderFilterHeader(i))}
                {renderSortableHeader("Score", "filterScore")}
                {renderSortableHeader("Status", "status")}
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-border/50">
              {filteredStocks.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={totalCols}
                    className="h-32 text-center text-muted-foreground font-mono text-sm"
                  >
                    No results found
                  </TableCell>
                </TableRow>
              ) : (
                filteredStocks.map((stock) => {
                  const flash = flashMap.get(stock.symbol);
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
                      {/* Symbol */}
                      <TableCell className="font-mono font-semibold text-primary px-3 py-2.5">
                        {stock.symbol}
                      </TableCell>

                      {/* Company */}
                      <TableCell
                        className="max-w-[150px] truncate text-muted-foreground px-3 py-2.5"
                        title={stock.company}
                      >
                        {stock.company}
                      </TableCell>

                      {/* Price */}
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

                      {/* Daily Change */}
                      <TableCell
                        className={`font-mono text-right px-3 py-2.5 ${
                          stock.dailyChangePercent > 0
                            ? "text-emerald-500"
                            : stock.dailyChangePercent < 0
                            ? "text-red-500"
                            : ""
                        }`}
                      >
                        {formatPercent(stock.dailyChangePercent)}
                      </TableCell>

                      {/* Filter pass/fail columns */}
                      {Array.from({ length: numFilters }, (_, i) => {
                        const fr = stock.filterResults?.[i];
                        const passed = fr?.passed ?? false;
                        const tooltip = fr
                          ? `${fr.name}\n\nResult: ${fr.calculatedValue}\nThreshold: ${fr.threshold}\n\n${fr.explanation}`
                          : `Filter ${i + 1}`;
                        return (
                          <TableCell
                            key={i}
                            className="text-center px-2 py-2.5"
                            title={tooltip}
                          >
                            {passed ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" />
                            ) : (
                              <XCircle className="h-4 w-4 text-red-500/70 mx-auto" />
                            )}
                          </TableCell>
                        );
                      })}

                      {/* Score */}
                      <TableCell className="font-mono text-right px-3 py-2.5 text-muted-foreground">
                        {stock.filterScore}%
                      </TableCell>

                      {/* Status badge */}
                      <TableCell className="px-3 py-2.5 text-center">
                        {(() => {
                          const isPartial =
                            stock.status !== "qualified" &&
                            (stock.filterResults?.[0]?.passed ?? false);
                          const label =
                            stock.status === "qualified"
                              ? "Pass"
                              : isPartial
                              ? "Partial"
                              : "Fail";
                          const variant =
                            stock.status === "qualified"
                              ? "success"
                              : isPartial
                              ? "warning"
                              : "danger";
                          return (
                            <Badge
                              variant={variant as "success" | "warning" | "danger"}
                              className="font-mono text-[10px] uppercase tracking-wider rounded-none px-1.5 py-0"
                            >
                              {label}
                            </Badge>
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
