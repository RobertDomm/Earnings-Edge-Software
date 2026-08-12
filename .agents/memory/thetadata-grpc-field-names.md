---
name: ThetaData gRPC column names
description: Actual column header names returned by ThetaData live gRPC snapshot endpoints — confirmed against live traffic.
---

## Quote snapshot (GetOptionSnapshotQuote)
Headers: `timestamp, symbol, expiration, strike, right, bid_size, bid_exchange, bid, bid_condition, ask_size, ask_exchange, ask, ask_condition`

- `right` = `"CALL"` or `"PUT"` (full word, uppercase) — NOT `"C"`/`"P"`.
- `bid`, `ask`, `bid_size`, `ask_size` match the alias list in market-data.ts.

## GreeksAll snapshot (GetOptionSnapshotGreeksAll)
Headers include: `symbol, expiration, strike, right, ..., implied_vol, iv_error, underlying_price`

- IV field is `implied_vol` — NOT `MidIV`, `mid_iv`, `IV`, or `ImpliedVolatility`.
- `right` same as above — `"CALL"`/`"PUT"`.

## Fix applied
`tdNormalizeRight(raw)` added after `tdGetStr` — converts `"CALL"→"C"`, `"PUT"→"P"`.
Used in all four places that previously used `.toUpperCase()` + check `"C"`/`"P"`.

`"implied_vol"` added as the first alias in the `tdGetNum` call for IV in `buildLiquidityMetrics`.

**Why:** ThetaData returns full words for the right field and a snake_case name for IV.
Without these fixes all quoteRows and greekRows were silently skipped, producing zero qualifying stocks.

**How to apply:** Any future gRPC snapshot call must use `tdNormalizeRight` before comparing right/side, and must include `"implied_vol"` in the IV alias list.
