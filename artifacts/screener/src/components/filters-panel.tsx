import { useGetScannerFilters } from "@workspace/api-client-react";
import { filterKey } from "@/lib/filter-key";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";

interface FilterPassCounts {
  counts: Map<string, number>;
  total: number;
}

interface FiltersPanelProps {
  filterPassCounts?: FilterPassCounts | null;
}

export function FiltersPanel({ filterPassCounts }: FiltersPanelProps) {
  const { data, isLoading, isError } = useGetScannerFilters();

  // Skeleton rows while loading
  if (isLoading) {
    return (
      <Card className="rounded-none border-border bg-muted/20 dark:bg-black/20 shadow-none">
        <CardHeader className="p-3 border-b border-border bg-muted/20">
          <CardTitle className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Active Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="flex flex-col divide-y divide-border">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between p-3 py-2.5">
                <span className="h-3 w-32 rounded bg-muted/40 animate-pulse" />
                <span className="h-3 w-20 rounded bg-muted/30 animate-pulse" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card className="rounded-none border-border bg-muted/20 dark:bg-black/20 shadow-none">
        <CardHeader className="p-3 border-b border-border bg-muted/20">
          <CardTitle className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Active Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3">
          <p className="text-xs font-mono text-muted-foreground opacity-60">
            Could not load filter definitions.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-none border-border bg-muted/20 dark:bg-black/20 shadow-none">
      <CardHeader className="p-3 border-b border-border bg-muted/20">
        <CardTitle className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Active Filters
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="flex flex-col divide-y divide-border">
          {data.filters.map((f) => {
            // When a scan has completed, absent map entry means 0 passed (not unknown)
            const hasCount = filterPassCounts != null;
            const passed   = hasCount ? (filterPassCounts.counts.get(filterKey(f.name)) ?? 0) : 0;
            const total    = filterPassCounts?.total ?? 0;
            const allPassed = hasCount && total > 0 && passed === total;

            return (
              <div key={f.name} className="flex flex-col gap-0.5 p-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-mono text-muted-foreground">
                    {f.name}
                  </span>
                </div>
                {hasCount && (
                  <p
                    className={[
                      "text-[10px] font-mono leading-tight mt-0.5",
                      allPassed
                        ? "text-up"
                        : passed === 0
                        ? "text-down-muted"
                        : "text-amber-600 dark:text-amber-400",
                    ].join(" ")}
                  >
                    {`${passed}/${total} passed`}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
