/**
 * useAutoScanner
 *
 * Automatically triggers POST /scanner/run on a configurable interval while
 * the market is in an active session. Pauses when the market is closed.
 *
 * Market states that trigger auto-scanning:
 *   open, pre_market, after_hours → scan on interval
 *   closed                         → paused (existing results still polled)
 *
 * The hook owns the "Run Scanner" mutation so the same button in the UI can
 * share the pending state whether a scan was triggered manually or auto.
 *
 * Interval is controlled by the parent via the `intervalSeconds` prop:
 *   0     → manual only (auto-scanning disabled)
 *   15..N → auto-scan every N seconds when market is active
 */

import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useRunScanner,
  getGetScannerResultsQueryKey,
} from "@workspace/api-client-react";

/** Market states considered "active" — auto-scanning fires for these. */
const ACTIVE_MARKET_STATES = new Set(["open", "pre_market", "after_hours"]);

export interface AutoScannerState {
  /** Whether auto-scanning is currently configured AND market is active */
  isAutoActive: boolean;
  /** Whether auto-scanning is configured but the market is currently closed */
  isPausedForClosed: boolean;
  /** Underlying mutation — use isPending to show spinner for both auto and manual runs */
  runScanner: ReturnType<typeof useRunScanner>;
  /** Trigger a manual scan immediately (respects isPending) */
  triggerManual: () => void;
}

export interface UseAutoScannerOptions {
  /** Current market state string from useGetMarketStatus().data?.state */
  marketState: string | undefined;
  /** Interval in seconds; 0 means manual-only */
  intervalSeconds: number;
  /** Master enable toggle — usually tied to auth.authorized */
  enabled: boolean;
}

export function useAutoScanner({
  marketState,
  intervalSeconds,
  enabled,
}: UseAutoScannerOptions): AutoScannerState {
  const queryClient = useQueryClient();
  const runScanner = useRunScanner();

  // Keep a ref to isPending so the interval closure doesn't go stale
  const isPendingRef = useRef(runScanner.isPending);
  isPendingRef.current = runScanner.isPending;

  const isMarketActive = !!marketState && ACTIVE_MARKET_STATES.has(marketState);
  const isAutoActive = enabled && intervalSeconds > 0 && isMarketActive;
  const isPausedForClosed =
    enabled && intervalSeconds > 0 && !!marketState && !isMarketActive;

  const doScan = useCallback(() => {
    if (isPendingRef.current) return;
    runScanner.mutate(undefined, {
      onSettled: () => {
        // Invalidate so useGetScannerResults picks up the new state immediately
        queryClient.invalidateQueries({
          queryKey: getGetScannerResultsQueryKey(),
        });
      },
    });
  }, [runScanner, queryClient]);

  useEffect(() => {
    if (!isAutoActive) return;

    // Fire immediately on mount / when conditions become active so the user
    // sees fresh data right away, then repeat on interval.
    doScan();

    const id = setInterval(doScan, intervalSeconds * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAutoActive, intervalSeconds]);

  const triggerManual = useCallback(() => {
    doScan();
  }, [doScan]);

  return {
    isAutoActive,
    isPausedForClosed,
    runScanner,
    triggerManual,
  };
}
