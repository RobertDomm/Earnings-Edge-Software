import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/hooks/use-theme";

interface ThemeToggleProps {
  theme: Theme;
  onToggle: () => void;
}

/**
 * Floating light/dark mode toggle pinned to the bottom-left corner.
 */
export function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  const isDark = theme === "dark";
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={onToggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="fixed bottom-4 left-4 z-50 h-9 w-9 rounded-none border-border bg-card/80 backdrop-blur-md hover:bg-accent"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
