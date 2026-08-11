import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Badge } from "./ui/badge";

export function FiltersPanel() {
  const filters = [
    { id: 1, label: "Filter 1", value: "—", status: "PENDING CONFIG" },
    { id: 2, label: "Filter 2", value: "—", status: "PENDING CONFIG" },
    { id: 3, label: "Filter 3", value: "—", status: "PENDING CONFIG" },
    { id: 4, label: "Filter 4", value: "—", status: "PENDING CONFIG" },
    { id: 5, label: "Filter 5", value: "—", status: "PENDING CONFIG" },
  ];

  return (
    <Card className="rounded-none border-border bg-black/20 shadow-none">
      <CardHeader className="p-3 border-b border-border bg-muted/20">
        <CardTitle className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Active Filters</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="flex flex-col divide-y divide-border">
          {filters.map((f) => (
            <div key={f.id} className="flex items-center justify-between p-3 py-2.5">
              <span className="text-xs font-mono text-muted-foreground">{f.label}</span>
              <div className="flex items-center gap-3">
                <span className="text-sm font-mono">{f.value}</span>
                <Badge variant="outline" className="text-[10px] font-mono tracking-wider rounded-none px-1.5 py-0 opacity-50 border-dashed">
                  {f.status}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}