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

type SortKey = "symbol" | "company" | "price" | "dailyChangePercent" | "nextEarningsDate" | "filterScore" | "status";

/** Badge showing whether an earnings date is confirmed or estimated. */
export function EarningsSourceBadge({
  source,
}: {
  source: "confirmed" | "estimated" | null | undefined;
}) {
  if (!source) return null;
  const confirmed = source === "confirmed";
  return (
    <span
      title={
        confirmed
          ? "Confirmed — date announced on the earnings calendar"
          : "Estimated — projected from the last quarterly filing (+91 days). Double-check before entry."
      }
      className={`inline-flex items-center font-mono text-[9px] uppercase tracking-wider px-1 py-0 border leading-tight ${
        confirmed
          ? "border-up/40 bg-up/10 text-up"
          : "border-amber-600/40 bg-amber-50 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-400"
      }`}
    >
      {confirmed ? "Confirmed" : "Est."}
    </span>
  );
}
type SortOrder = "asc" | "desc" | null;

// Short labels shown in the column header (tooltip shows full filter name).
const FILTER_SHORT_LABELS = ["F1", "F2", "F3", "F4", "F5", "F6"];

export function ResultsTable({ stocks, flashThreshold = 0.001 }: ResultsTableProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pass" | "partial">("pass");
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
        // Partial Pass requires BOTH Filter 1 (Sector Exclusion) AND
        // Filter 2 (Earnings in 2 Weeks) to have passed — a stock outside
        // the earnings entry window never shows up here, regardless of how
        // many other filters it passes.
        const isPartialPass =
          s.status !== "qualified" &&
          (s.filterResults?.[0]?.passed ?? false) &&
          (s.filterResults?.[1]?.passed ?? false);
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

  const renderSortableHeader = (label: string, key: SortKey, align: "left" | "center" = "left") => (
    <TableHead
      className="cursor-pointer group select-none whitespace-nowrap text-xs font-mono font-normal uppercase tracking-wider h-10 px-3 py-2 bg-muted/30"
      onClick={() => handleSort(key)}
    >
      <div className={`flex items-center${align === "center" ? " justify-center" : ""}`}>
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
  // colSpan: Symbol + Company + Price + Change + Earnings + filters + Score + Status
  const totalCols = 5 + numFilters + 2;

  return (
    <div className="flex flex-col gap-4 w-full h-full">
      <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search symbol or company..."
            className="pl-9 rounded-none font-mono text-xs border-border bg-muted/40 dark:bg-black/40 h-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            value={statusFilter}
            onValueChange={(v: "all" | "pass" | "partial") => setStatusFilter(v)}
          >
            <SelectTrigger className="rounded-none font-mono text-xs border-border bg-muted/40 dark:bg-black/40 h-9">
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

      <div className="border border-border bg-muted/20 dark:bg-black/20 overflow-hidden flex-1 relative">
        <div className="overflow-auto max-h-[800px]">
          <Table className="w-full text-sm">
            <TableHeader className="sticky top-0 z-10 border-b border-border shadow-sm">
              <TableRow className="hover:bg-transparent border-none">
                {renderSortableHeader("Symbol", "symbol")}
                {renderSortableHeader("Company", "company")}
                {renderSortableHeader("Price", "price")}
                {renderSortableHeader("Daily Change", "dailyChangePercent", "center")}
                {renderSortableHeader("Earnings", "nextEarningsDate")}
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
                                ? "bg-up-subtle text-up-fg"
                                : "bg-down-subtle text-down-fg"
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
                        className={`font-mono text-center px-3 py-2.5 ${
                          stock.dailyChangePercent > 0
                            ? "text-up"
                            : stock.dailyChangePercent < 0
                            ? "text-down"
                            : ""
                        }`}
                      >
                        {formatPercent(stock.dailyChangePercent)}
                      </TableCell>

                      {/* Earnings date + confirmed/estimated badge */}
                      <TableCell className="font-mono whitespace-nowrap px-3 py-2.5">
                        {stock.nextEarningsDate ? (
                          <span className="inline-flex items-center gap-1.5">
                            {stock.nextEarningsDate}
                            <EarningsSourceBadge source={stock.earningsDateSource} />
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>

                      {/* Filter pass/fail/bypass columns */}
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
                              <CheckCircle2 className="h-4 w-4 text-up-muted mx-auto" />
                            ) : (
                              <XCircle className="h-4 w-4 text-down-muted mx-auto" />
                            )}
                          </TableCell>
                        );
                      })}

                      {/* Score: count of filters passed */}
                      <TableCell className="font-mono text-right px-3 py-2.5 text-muted-foreground">
                        {stock.filterResults
                          ? (() => {
                              const passedCount = stock.filterResults.filter(fr => fr.passed).length;
                              const total       = stock.filterResults.length;
                              return `${passedCount}/${total}`;
                            })()
                          : "—"}
                      </TableCell>

                      {/* Status badge */}
                      <TableCell className="px-3 py-2.5 text-center">
                        {(() => {
                          const qualified = stock.status === "qualified";
                          const label   = qualified ? "Pass" : (stock.filterResults?.[0]?.passed ?? false) ? "Partial" : "Fail";
                          const variant = qualified ? "success" : (stock.filterResults?.[0]?.passed ?? false) ? "warning" : "danger";
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
