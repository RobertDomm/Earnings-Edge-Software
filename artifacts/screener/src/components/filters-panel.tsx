import { useGetScannerFilters } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";

interface FilterPassCounts {
  counts: Map<string, number>;
  /** Number of stocks for which each filter was bypassed (data unavailable from provider). */
  bypassCounts?: Map<string, number>;
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
      <Card className="rounded-none border-border bg-black/20 shadow-none">
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
      <Card className="rounded-none border-border bg-black/20 shadow-none">
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
    <Card className="rounded-none border-border bg-black/20 shadow-none">
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
            const passed   = hasCount ? (filterPassCounts.counts.get(f.name) ?? 0) : 0;
            const bypassed = hasCount ? (filterPassCounts.bypassCounts?.get(f.name) ?? 0) : 0;
            const total    = filterPassCounts?.total ?? 0;
            const allPassed   = hasCount && total > 0 && passed === total;
            // All stocks had this filter bypassed — data is unavailable from the provider
            const allBypassed = hasCount && total > 0 && bypassed === total && passed === 0;
            // Some stocks bypassed, some genuinely passed (mixed)
            const someBypassed = hasCount && bypassed > 0 && !allBypassed;

            return (
              <div key={f.name} className="flex flex-col gap-0.5 p-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-mono text-muted-foreground">
                    {f.name}
                  </span>
                  {allBypassed && (
                    <span
                      className="text-[9px] font-mono uppercase tracking-wider text-amber-400/70 border border-amber-400/30 px-1 py-0 leading-tight whitespace-nowrap"
                      title="Data for this filter is not available from the current provider. All stocks are treated as bypassed — verify manually before entry."
                    >
                      bypassed
                    </span>
                  )}
                </div>
                <p className="text-[11px] font-mono text-muted-foreground opacity-60 leading-tight">
                  {f.description}
                </p>
                {hasCount && (
                  <p
                    className={[
                      "text-[10px] font-mono leading-tight mt-0.5",
                      allBypassed
                        ? "text-amber-400/70"
                        : allPassed
                        ? "text-emerald-500"
                        : passed === 0
                        ? "text-red-500/70"
                        : "text-amber-400/80",
                    ].join(" ")}
                  >
                    {allBypassed
                      ? `${bypassed}/${total} bypassed by provider`
                      : someBypassed
                      ? `${passed}/${total} passed • ${bypassed} bypassed ⚠`
                      : `${passed}/${total} passed`}
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
