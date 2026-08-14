---
name: Nasdaq earnings endpoints
description: Keyless Nasdaq APIs used for confirmed future and historical past earnings dates; UA requirement and roles.
---

Two keyless Nasdaq endpoints (both require a browser-like User-Agent header or they hang/reject):

1. `https://api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD` — confirmed FUTURE earnings dates, one request per calendar day; overlaid on the Polygon +91-day estimate for Filters 2/5.
2. `https://api.nasdaq.com/api/company/{symbol}/earnings-surprise` — HISTORICAL reported earnings dates (last ~4 quarters, `dateReported` in `M/D/YYYY`, most recent first). Used as the fallback source of past earnings dates for foreign ADRs (BABA, TSM, JD, ...) whose quarters never appear in Polygon's SEC-filings feed, so Filter 4 gets a real pass/fail instead of a bypass.

**Why:** Polygon `/vX/reference/financials` returns zero quarterly filings for ADRs; only US SEC filers appear there.

**How to apply:** any feature needing past earnings dates for non-US names should reuse the earnings-surprise lookup (cached 24h per symbol, failures not cached) rather than adding a paid provider.
