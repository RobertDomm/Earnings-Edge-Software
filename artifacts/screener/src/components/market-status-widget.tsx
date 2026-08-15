import { useGetMarketStatus, getGetMarketStatusQueryKey } from "@workspace/api-client-react";
import { Badge } from "./ui/badge";
import { Clock } from "lucide-react";
import { Card, CardContent } from "./ui/card";

export function MarketStatusWidget() {
  const { data: marketStatus, isLoading } = useGetMarketStatus({
    query: {
      queryKey: getGetMarketStatusQueryKey(),
      refetchInterval: 60000,
    }
  });

  if (isLoading) {
    return (
      <Card className="rounded-none border-border/50 bg-muted/40 dark:bg-black/40 shadow-none">
        <CardContent className="p-4 flex items-center gap-4 animate-pulse">
          <div className="h-4 w-24 bg-muted/50"></div>
          <div className="h-4 w-32 bg-muted/50"></div>
        </CardContent>
      </Card>
    );
  }

  if (!marketStatus) return null;

  const stateColors: Record<string, "success" | "danger" | "warning" | "default"> = {
    open: "success",
    closed: "danger",
    pre_market: "warning",
    after_hours: "warning",
  };

  const badgeColor = stateColors[marketStatus.state] || "default";

  return (
    <Card className="rounded-none border-border bg-muted/40 dark:bg-black/40 shadow-none backdrop-blur-sm relative overflow-hidden">
      <div className="absolute top-0 left-0 w-1 h-full bg-border" />
      <CardContent className="p-4 flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Market Status</span>
            <Badge variant={badgeColor} className="uppercase font-mono text-[10px] tracking-wider rounded-none px-1.5 py-0">
              {marketStatus.label}
            </Badge>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground mt-1">
            <Clock className="h-3 w-3" />
            {marketStatus.nextOpen && (
              <span>Next Open: <span className="text-foreground">{new Date(marketStatus.nextOpen).toLocaleTimeString()}</span></span>
            )}
            {marketStatus.nextClose && (
              <span>Next Close: <span className="text-foreground">{new Date(marketStatus.nextClose).toLocaleTimeString()}</span></span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
