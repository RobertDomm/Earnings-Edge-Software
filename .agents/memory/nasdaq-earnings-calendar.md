---
name: Nasdaq earnings calendar
description: Keyless source of confirmed earnings dates used to overlay Polygon's +91-day estimate
---

Confirmed earnings dates come from Nasdaq's public API: `https://api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD` — no API key needed, but it **rejects requests without a browser-like User-Agent header**. Response shape: `{data:{rows:[{symbol,...}]}}`; rows may be null on empty days.

**Why:** The screener's 14–18 day entry window is strict; the Polygon "+91 days after last filing" estimate can drift several days, so confirmed dates are overlaid on top and the estimate is only a fallback (`earningsDateSource: "confirmed" | "estimated"` on StockQuote).

**How to apply:** Bulk-fetch weekdays for the lookahead range once (12h cache; total failure negative-cached ~15 min so an outage can't cause a request flood). Filters 2/5 append ", confirmed"/", estimated" to their displayed values. Lookups never throw — unavailable calendar just means fallback to estimate.
