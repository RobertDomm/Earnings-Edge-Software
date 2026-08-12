/**
 * useTimeAgo
 *
 * Returns a human-readable "X ago" string that updates every second.
 * Returns null when no timestamp is provided.
 *
 * Examples: "just now", "14s ago", "3m ago", "2h ago"
 */
import { useState, useEffect } from "react";

function computeTimeAgo(timestamp: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000)
  );
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function useTimeAgo(timestamp: string | null | undefined): string | null {
  const [label, setLabel] = useState<string | null>(
    timestamp ? computeTimeAgo(timestamp) : null
  );

  useEffect(() => {
    if (!timestamp) {
      setLabel(null);
      return;
    }

    // Update immediately
    setLabel(computeTimeAgo(timestamp));

    const id = setInterval(() => {
      setLabel(computeTimeAgo(timestamp));
    }, 1000);

    return () => clearInterval(id);
  }, [timestamp]);

  return label;
}
