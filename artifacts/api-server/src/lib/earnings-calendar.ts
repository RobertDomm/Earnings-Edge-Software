/**
 * Confirmed earnings calendar — Nasdaq's public earnings calendar API.
 *
 * The screener's entry window (Filters 2 and 5) is a strict 14–18 day band,
 * so estimated dates ("last quarterly filing + 91 days") can misfire by a few
 * days. This module supplies CONFIRMED/announced earnings dates from
 * https://api.nasdaq.com/api/calendar/earnings (no API key required), which
 * providers overlay on top of the +91-day estimate.
 *
 * Behaviour:
 *  - One bulk fetch covers all symbols: every weekday from today through
 *    today + CALENDAR_LOOKAHEAD_DAYS is queried and merged into a
 *    symbol → date map.
 *  - The map is cached for 12h on success. A total failure is cached for
 *    15 min (negative cache) so a Nasdaq outage cannot turn every universe
 *    refresh into a burst of doomed requests.
 *  - Lookups never throw; a missing/unavailable calendar simply yields null
 *    and callers fall back to the estimate.
 */

const NASDAQ_BASE = "https://api.nasdaq.com/api/calendar/earnings";

/** How far ahead to pull the calendar. The entry window is 14–18 days, so 45
 *  days comfortably covers the window plus "too early / too late" context. */
const CALENDAR_LOOKAHEAD_DAYS = 45;

/** Successful calendar snapshots are reused for 12 hours. */
const CALENDAR_TTL_MS = 12 * 60 * 60 * 1000;

/** A totally failed snapshot is cached briefly so refreshes don't hammer Nasdaq. */
const CALENDAR_FAILURE_TTL_MS = 15 * 60 * 1000;

/** Max concurrent per-day requests during a snapshot build. */
const FETCH_CONCURRENCY = 5;

interface NasdaqEarningsRow {
  symbol?: string;
}
interface NasdaqEarningsResponse {
  data?: { rows?: NasdaqEarningsRow[] | null } | null;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface EarningsCalendarOptions {
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable "today" for tests (local time). */
  today?: Date;
}

interface CalendarSnapshot {
  /** symbol → confirmed earnings date (YYYY-MM-DD). Empty map on total failure. */
  dates: Map<string, string>;
  fetchedAt: number;
  /** True when every per-day request failed (negative-cache entry). */
  failed: boolean;
}

let snapshot: CalendarSnapshot | null = null;
let building: Promise<CalendarSnapshot> | null = null;

/** Test hook: drop the cached calendar snapshot. */
export function clearEarningsCalendarCache(): void {
  snapshot = null;
  building = null;
}

function toLocalYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Weekday (Mon–Fri) dates from `today` through `today + CALENDAR_LOOKAHEAD_DAYS`. */
function calendarDates(today: Date): string[] {
  const out: string[] = [];
  const d = new Date(today);
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i <= CALENDAR_LOOKAHEAD_DAYS; i++) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) out.push(toLocalYmd(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** Fetches one calendar day; returns rows (possibly empty) or throws. */
async function fetchCalendarDay(dateStr: string, fetchImpl: FetchLike): Promise<NasdaqEarningsRow[]> {
  const res = await fetchImpl(`${NASDAQ_BASE}?date=${dateStr}`, {
    headers: {
      // Nasdaq's API rejects requests without a browser-like User-Agent.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Nasdaq earnings calendar HTTP ${res.status} for ${dateStr}`);
  const body = (await res.json()) as NasdaqEarningsResponse;
  return body?.data?.rows ?? [];
}

async function buildSnapshot(opts: EarningsCalendarOptions): Promise<CalendarSnapshot> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const dates = calendarDates(opts.today ?? new Date());
  const map = new Map<string, string>();
  let okDays = 0;
  let failedDays = 0;

  // Simple concurrency-limited worker pool over the date list.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < dates.length) {
      const dateStr = dates[cursor++]!;
      try {
        const rows = await fetchCalendarDay(dateStr, fetchImpl);
        for (const row of rows) {
          const sym = row.symbol?.toUpperCase().trim();
          // Keep the EARLIEST confirmed date per symbol (dates are iterated in
          // ascending order per worker, but workers interleave — guard with has()
          // + lexicographic compare, which works for YYYY-MM-DD).
          if (sym && (!map.has(sym) || dateStr < map.get(sym)!)) map.set(sym, dateStr);
        }
        okDays++;
      } catch {
        failedDays++;
      }
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => worker()));

  const failed = okDays === 0;
  if (failed) {
    console.warn(
      `[EarningsCalendar] All ${failedDays} Nasdaq calendar requests failed — ` +
      `confirmed earnings dates unavailable; falling back to +91-day estimates for ${Math.round(CALENDAR_FAILURE_TTL_MS / 60000)} min.`,
    );
  } else if (failedDays > 0) {
    console.warn(
      `[EarningsCalendar] ${failedDays}/${okDays + failedDays} Nasdaq calendar days failed to load — ` +
      `calendar coverage is partial; symbols on missing days fall back to estimates.`,
    );
  }

  return { dates: map, fetchedAt: Date.now(), failed };
}

/**
 * Returns the full confirmed-calendar map (symbol → YYYY-MM-DD), building or
 * refreshing the cached snapshot as needed. Never throws.
 */
export async function getConfirmedEarningsCalendar(
  opts: EarningsCalendarOptions = {},
): Promise<Map<string, string>> {
  const ttl = snapshot?.failed ? CALENDAR_FAILURE_TTL_MS : CALENDAR_TTL_MS;
  if (snapshot && Date.now() - snapshot.fetchedAt < ttl) return snapshot.dates;

  if (!building) {
    building = buildSnapshot(opts)
      .then((s) => {
        snapshot = s;
        return s;
      })
      .finally(() => {
        building = null;
      });
  }
  const s = await building;
  return s.dates;
}

/**
 * Confirmed earnings date for one symbol, or null when the calendar has no
 * entry (or is unavailable). Never throws.
 */
export async function getConfirmedEarningsDate(
  symbol: string,
  opts: EarningsCalendarOptions = {},
): Promise<string | null> {
  try {
    const cal = await getConfirmedEarningsCalendar(opts);
    return cal.get(symbol.toUpperCase()) ?? null;
  } catch (err) {
    // Defensive: buildSnapshot never throws, but a cache-layer bug must not
    // break enrichment. Log — never silent.
    console.warn(
      `[EarningsCalendar] ${symbol}: unexpected lookup failure — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
