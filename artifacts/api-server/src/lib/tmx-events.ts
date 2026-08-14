/**
 * TMX Corporate Events — Polygon add-on (global earnings calendar).
 *
 * `GET https://api.polygon.io/tmx/v1/corporate-events?ticker=X` returns
 * exchange-sourced corporate events worldwide, including earnings for foreign
 * companies trading as ADRs (BABA, TSM, JD, ...) that never appear in
 * Polygon's SEC-filings feed. Works with the existing MARKET_DATA_API_KEY
 * once the TMX add-on is active on the plan.
 *
 * We extract two things per ticker:
 *  - nextEarningsDate: the earliest CONFIRMED future `earnings_announcement_date`
 *    (primary source for Filters 2 and 5's entry window).
 *  - historicalEarningsDates: past earnings dates (most recent first), used to
 *    anchor Filter 4's 4-quarter volatility history when SEC filings are
 *    missing.
 *
 * Note: the endpoint's `type=` query parameter returns empty results for
 * `earnings` (verified live), so we fetch all events and filter client-side.
 *
 * Failure policy mirrors the other Polygon helpers: retries with backoff on
 * transient errors, classified warn logs, null on failure (callers fall back
 * to Nasdaq / estimates), and a 24h success-only cache.
 */

const TMX_BASE = "https://api.polygon.io/tmx/v1/corporate-events";

/** Successful lookups are reused for 24 hours (earnings dates move rarely). */
const TMX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Event `type` values that carry an earnings date. */
const EARNINGS_EVENT_TYPES = new Set([
  "earnings_announcement_date",
  "earnings_results_announcement",
]);

export interface TmxEarningsEvents {
  /** Earliest confirmed FUTURE earnings announcement date (YYYY-MM-DD), or null. */
  nextEarningsDate: string | null;
  /** Past earnings dates, most recent first. May be empty. */
  historicalEarningsDates: string[];
}

interface TmxEventRow {
  date?: string;
  type?: string;
  status?: string;
}
interface TmxEventsResponse {
  status?: string;
  results?: TmxEventRow[] | null;
}

export interface TmxFetchOptions {
  /** Retries after the initial attempt for transient failures. Default 2. */
  retries?: number;
  /** Base backoff in ms; attempt n waits retryBaseMs × 2ⁿ. Default 250. Tests pass 1. */
  retryBaseMs?: number;
  /** Awaited before every HTTP request (incl. retries) — pass a rate limiter's acquire(). */
  acquireSlot?: () => Promise<void>;
  /** Injectable "today" (YYYY-MM-DD) for tests. Defaults to local date. */
  todayYmd?: string;
}

function localTodayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Fetches and parses a ticker's TMX earnings events. Returns null on failure
 * (never throws); every failure is warn-logged with a classified reason.
 */
export async function fetchTmxEarningsEvents(
  apiKey: string,
  ticker: string,
  opts: TmxFetchOptions = {},
): Promise<TmxEarningsEvents | null> {
  const maxRetries = opts.retries ?? 2;
  const retryBaseMs = opts.retryBaseMs ?? 250;
  const todayYmd = opts.todayYmd ?? localTodayYmd();

  let body: TmxEventsResponse;
  for (let attempt = 0; ; attempt++) {
    try {
      if (opts.acquireSlot) await opts.acquireSlot();
      const url = new URL(TMX_BASE);
      url.searchParams.set("ticker", ticker);
      url.searchParams.set("limit", "250");
      url.searchParams.set("apiKey", apiKey);
      const res = await fetch(url);
      if (!res.ok) {
        if (attempt < maxRetries && isRetryableStatus(res.status)) {
          await new Promise((r) => setTimeout(r, retryBaseMs * 2 ** attempt));
          continue;
        }
        const reason =
          res.status === 401 || res.status === 403
            ? `auth/entitlement error (HTTP ${res.status}) — is the TMX Corporate Events add-on active?`
            : res.status === 429
              ? "rate limited (HTTP 429)"
              : `server error (HTTP ${res.status})`;
        console.warn(`[TmxEvents] ${ticker}: ${reason}. Falling back to Nasdaq/estimates.`);
        return null;
      }
      body = (await res.json()) as TmxEventsResponse;
      break;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryBaseMs * 2 ** attempt));
        continue;
      }
      console.warn(
        `[TmxEvents] ${ticker}: network/parse failure after retries — ` +
        `${err instanceof Error ? err.message : String(err)}. Falling back to Nasdaq/estimates.`,
      );
      return null;
    }
  }

  const rows = body.results ?? [];
  const futureConfirmed: string[] = [];
  const past = new Set<string>();

  for (const row of rows) {
    const date = row.date;
    const type = row.type ?? "";
    if (!date || !EARNINGS_EVENT_TYPES.has(type)) continue;
    if (date > todayYmd) {
      // Only confirmed announcement dates are trustworthy for the entry window.
      if (type === "earnings_announcement_date" && row.status === "confirmed") {
        futureConfirmed.push(date);
      }
    } else if (date < todayYmd) {
      past.add(date);
    }
  }

  return {
    nextEarningsDate: futureConfirmed.length > 0 ? futureConfirmed.sort()[0]! : null,
    historicalEarningsDates: [...past].sort((a, b) => (a < b ? 1 : -1)),
  };
}

const tmxCache = new Map<string, { data: TmxEarningsEvents; fetchedAt: number }>();

/** Test hook: drop the cached TMX events. */
export function clearTmxEventsCache(): void {
  tmxCache.clear();
}

/**
 * Cached wrapper (24h TTL, successes only — failures retry on the next
 * refresh, same policy as the other Polygon helpers).
 */
export async function fetchTmxEarningsEventsCached(
  apiKey: string,
  ticker: string,
  opts: TmxFetchOptions = {},
): Promise<TmxEarningsEvents | null> {
  const hit = tmxCache.get(ticker);
  if (hit && Date.now() - hit.fetchedAt < TMX_CACHE_TTL_MS) return hit.data;

  const data = await fetchTmxEarningsEvents(apiKey, ticker, opts);
  if (data !== null) tmxCache.set(ticker, { data, fetchedAt: Date.now() });
  return data;
}
