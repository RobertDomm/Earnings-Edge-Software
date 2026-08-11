# Circle Screener

A Circle-gated stock & options screening dashboard. Authorized members of a designated Circle Space Group can scan and filter stocks using a modular screening engine. All access is verified server-side — sharing the URL never grants access.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port varies, check artifact.toml)
- `pnpm --filter @workspace/screener run dev` — run the frontend (port varies)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + express-session (HttpOnly, Secure cookies)
- Frontend: React + Vite + Tailwind CSS + shadcn/ui, wouter routing
- Market data: MockMarketDataProvider (dev default) / LiveMarketDataProvider via Polygon.io (set MARKET_DATA_PROVIDER=live)
- Auth: MockCircleAuthService in development (swap for LiveCircleAuthService)
- Build: esbuild (CJS bundle for server)

## Where things live

| Area | Path |
|------|------|
| OpenAPI contract | `lib/api-spec/openapi.yaml` |
| Generated hooks | `lib/api-client-react/src/generated/` |
| Generated Zod schemas | `lib/api-zod/src/generated/` |
| Circle auth interface | `artifacts/api-server/src/lib/circle-auth.ts` |
| Mock Circle auth | `artifacts/api-server/src/lib/mock-circle-auth.ts` |
| Market data interface | `artifacts/api-server/src/lib/market-data.ts` |
| Screening engine + filter rules | `artifacts/api-server/src/lib/screening-engine.ts` |
| Auth routes | `artifacts/api-server/src/routes/auth.ts` |
| Scanner routes | `artifacts/api-server/src/routes/scanner.ts` |
| Stock detail route | `artifacts/api-server/src/routes/stocks.ts` |
| Market status route | `artifacts/api-server/src/routes/market.ts` |
| Frontend pages | `artifacts/screener/src/pages/` |
| Frontend components | `artifacts/screener/src/components/` |

## Architecture decisions

- **Circle authorization is fully isolated** — `ICircleAuthService` interface separates auth from dashboard logic. Swapping in real Circle OAuth requires only implementing `LiveCircleAuthService`.
- **Server-side session only** — no client-side auth flags. `requireAuth` middleware on every protected endpoint. Frontend flags are never trusted.
- **Modular screening engine** — `FILTER_RULES` array in `screening-engine.ts` is the only place to add/modify filters. Each rule is a standalone `IFilterRule` object.
- **MockMarketDataProvider** — `marketDataProvider` singleton in `services.ts`. Replace with `LiveMarketDataProvider` when a real data feed is available.
- **Mock mode blocked in production** — `MockCircleAuthService` throws if `NODE_ENV=production`. Cannot accidentally ship with mock auth.

## Product

- Dashboard with market status, scanner status, "Run Scanner" button, 5 placeholder filter slots, and a sortable/searchable stock results table
- Stock detail slide-over: overview stats, full options chain table, filter-by-filter PASS/FAIL breakdown
- Access Restricted page for unauthorized users; dev-mode login helper for testing

## Development mock auth

Set `CIRCLE_AUTH_MODE=mock` (default in development). Navigate to the Access Restricted page and click **[DEV] Inject Authorized Session** to simulate an authorized user. Or use the scenarios directly:

| URL | Result |
|-----|--------|
| `/api/auth/login?scenario=authorized` | ACCESS GRANTED — Circle member + Space Group |
| `/api/auth/login?scenario=unauthorized` | ACCESS DENIED — Circle member, no Space Group |
| `/api/auth/login?scenario=anonymous` | ACCESS DENIED — not a Circle member |

## What's needed for real Circle auth

To connect real Circle OAuth:

1. **Get from Circle developer settings:**
   - `CIRCLE_CLIENT_ID` — OAuth application client ID
   - `CIRCLE_CLIENT_SECRET` — OAuth application client secret
   - `CIRCLE_REQUIRED_SPACE_GROUP_ID` — the Space Group ID that grants access
   - `CIRCLE_COMMUNITY_ID` — your community identifier
   - `CIRCLE_API_TOKEN` — API token for Space Group membership verification

2. **Configure in Circle dashboard:**
   - OAuth callback URL: `https://<your-domain>/api/auth/callback`

3. **Implement `LiveCircleAuthService`** in `artifacts/api-server/src/lib/mock-circle-auth.ts` (stub is documented there)

4. **Set environment variables:**
   - `CIRCLE_AUTH_MODE=live`
   - All credentials above in Replit Secrets

5. **Set `NODE_ENV=production`** — mock mode is automatically blocked.

## What's needed for live market data

`LiveMarketDataProvider` is already implemented using **Polygon.io**. To activate it:

1. Get a free (or paid) API key at [polygon.io](https://polygon.io/)
2. Add it to Replit Secrets: `MARKET_DATA_API_KEY=<your key>`
3. Set `MARKET_DATA_PROVIDER=live` in the environment (shared or production)
4. Restart the API server — it will log `dataProvider: LiveMarketDataProvider (Polygon.io)`

The live provider fetches:
- **Stock universe** — ~75 high-liquidity optionable US equities + ETFs (edit `LIVE_STOCK_UNIVERSE` in `market-data.ts` to customize)
- **Options chains** — real contracts with Greeks via `/v3/snapshot/options/{ticker}` (Greeks require a paid Polygon plan; free tier returns quotes without them)
- **Market status** — precise session state (pre-market, open, after-hours) via `/v1/marketstatus/now`

**Polygon plan requirement**: live mode makes ~150 API calls per universe refresh (1 batch snapshot + 2 per ticker). The default rate limit is **100 req/min** (Polygon Starter plan), which completes the first cache populate in ~2 minutes. The free tier (5 req/min) takes ~30 minutes — not recommended for production. Set `POLYGON_REQUESTS_PER_MINUTE=5` explicitly if you only have a free key and are testing.

The mock provider remains the default (`MARKET_DATA_PROVIDER` unset or `mock`) and requires no API key.

## Where to add real filter rules

Open `artifacts/api-server/src/lib/screening-engine.ts`. Scroll to the `FILTER_RULES` array at the bottom. Each rule implements `IFilterRule`:

```typescript
const myRule: IFilterRule = {
  name: "My Filter Name",
  evaluate(stock: StockQuote): FilterResult {
    const passed = /* your logic here */;
    return { name: this.name, passed, calculatedValue: "...", threshold: "...", explanation: "..." };
  },
};

export const FILTER_RULES: IFilterRule[] = [myRule, ...otherRules];
```

Replace the 5 placeholder rules with the actual strategy. No other files need to change.

## Required environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_SECRET` | Yes (already set) | Secret for signing session cookies |
| `CIRCLE_AUTH_MODE` | No (defaults to `mock`) | `mock` for dev, `live` for production |
| `CIRCLE_CLIENT_ID` | Live mode only | OAuth client ID |
| `CIRCLE_CLIENT_SECRET` | Live mode only | OAuth client secret |
| `CIRCLE_COMMUNITY_ID` | Live mode only | Circle community ID |
| `CIRCLE_REQUIRED_SPACE_GROUP_ID` | Live mode only | Space Group that grants access |
| `CIRCLE_API_TOKEN` | Live mode only | API token for membership checks |
| `MARKET_DATA_PROVIDER` | No (defaults to mock) | `mock` or `live` |
| `MARKET_DATA_API_KEY` | Live data only | Polygon.io API key |
| `POLYGON_REQUESTS_PER_MINUTE` | No (defaults to 5) | Rate limit for Polygon API calls; 5 = free tier, set higher for paid plans |

## Gotchas

- After changing `lib/api-spec/openapi.yaml`, always run codegen: `pnpm --filter @workspace/api-spec run codegen`
- `CIRCLE_AUTH_MODE=mock` is blocked when `NODE_ENV=production` — this is intentional
- Session revalidation TTL is 15 minutes — changing Space Group membership in Circle takes up to 15 min to propagate to access denial
- The scanner state is in-memory — restarting the API server clears it; call "Run Scanner" again after restart
