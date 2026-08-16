import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ColorblindToggleProps {
  colorblind: boolean;
  onToggle: () => void;
}

/**
 * Floating colorblind-mode toggle pinned to the bottom-left corner,
 * just above the theme toggle. Switches the status palette from
 * green/red to blue/orange for users with red-green color vision deficiency.
 */
export function ColorblindToggle({ colorblind, onToggle }: ColorblindToggleProps) {
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={onToggle}
      aria-label={colorblind ? "Disable colorblind-friendly palette" : "Enable colorblind-friendly palette (blue/orange)"}
      title={colorblind ? "Colorblind mode: on — click to disable" : "Colorblind mode: off — click to enable blue/orange palette"}
      className="fixed bottom-16 left-4 z-50 h-9 w-9 rounded-none border-border bg-card/80 backdrop-blur-md hover:bg-accent"
    >
      {colorblind ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
    </Button>
  );
}
