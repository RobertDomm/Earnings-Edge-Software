---
name: Filter bypass for null earnings/IV data
description: Filters 2, 4, 5 set bypassed=true (not passed=true) when required data is null — surfaces ThetaData stocks as qualified_with_caveats.
updated: 2026-08-12
---

## Rule
Filters 2, 4, and 5 return `{ passed: false, bypassed: true }` when the required data is null.
The stock then surfaces as `status="qualified_with_caveats"` (not "not_qualified"), signalling
manual review rather than a clean pass or clean rejection.

- **Filter 2** (`nextEarningsDate === null`): bypassed with explanation "Earnings date unavailable … filter bypassed."
- **Filter 4** (`earningsIvHistory === null`): bypassed with explanation "Historical IV data unavailable … filter bypassed."
- **Filter 5** (`nextEarningsDate === null`): same as Filter 2.

Note: `earningsIvHistory = []` (empty array, not null) still fails with "Insufficient earnings history".

## ScreeningResult semantics
- `qualified = true`              — all 6 filters genuinely passed, no bypasses, no failures.
- `qualifiedWithCaveats = true`   — no filter failed; ≥1 filter was bypassed for missing data.
- `status = "qualified_with_caveats"` when qualifiedWithCaveats; "qualified" when qualified; else "not_qualified".
- `filterScore` credits both genuine passes AND bypasses (only failures penalise the score).

## Why
ThetaData does not expose earnings calendar or historical options IV on the current subscription tier.
All ThetaData stocks have `nextEarningsDate: null` and `earningsIvHistory: null`.  Without bypass,
zero stocks could surface in ThetaData mode.  Converting null → genuine pass would misrepresent
the filter outcome; the distinct "bypassed" state preserves the semantic contract.

## How to apply
Any future filter that depends on data the current provider cannot supply should return
`{ passed: false, bypassed: true }` with a clear bypass explanation rather than hard-failing or
faking a pass.  Never use `passed: true` for data that has not actually been evaluated.
