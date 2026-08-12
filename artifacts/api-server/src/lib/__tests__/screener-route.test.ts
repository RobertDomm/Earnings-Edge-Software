/**
 * screener-route.test.ts
 *
 * HTTP-layer integration tests for GET /screener.
 *
 * These tests spin up a real Express server on a random port, inject a
 * stubbed IMarketDataProvider, and assert the response status + JSON shape.
 * No network I/O and no SESSION_SECRET are required.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 *
 * Scenarios covered:
 *   1. Provider throws         → 503 with { error, detail, results: null }
 *   2. Provider returns []     → 200 with { results: [], totalScanned: 0, message }
 *   3. Provider returns stocks → 200 with screening results
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { createScreenerRouter } from "../../routes/screener.js";
import type {
  IMarketDataProvider,
  StockQuote,
  OptionsChain,
  MarketStatusData,
  StockUniverseResult,
} from "../market-data.js";
import { MOCK_STOCKS } from "../market-data.js";

// ---------------------------------------------------------------------------
// Minimal stub provider factory
// ---------------------------------------------------------------------------

type StubMode =
  | { kind: "throw"; message: string }
  | { kind: "empty" }
  | { kind: "stocks"; stocks: StockQuote[] };

function makeStubProvider(mode: StubMode): IMarketDataProvider {
  return {
    providerName: "stub",

    async getStockUniverse(): Promise<StockUniverseResult> {
      if (mode.kind === "throw") {
        throw new Error(mode.message);
      }
      return {
        stocks: mode.kind === "stocks" ? mode.stocks : [],
        dataFreshness: {
          timestamp: new Date().toISOString(),
          source: "live",
        },
      };
    },

    async getStockQuote(_symbol: string): Promise<StockQuote | null> {
      return null;
    },

    async getOptionsChain(_symbol: string): Promise<OptionsChain | null> {
      return null;
    },

    async getMarketStatus(): Promise<MarketStatusData> {
      return {
        state: "open",
        label: "OPEN",
        description: "Market is open",
        timestamp: new Date(),
        nextOpen: null,
        nextClose: null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal test Express app (no session, no auth required for these tests)
// ---------------------------------------------------------------------------

function buildTestApp(mode: StubMode): express.Express {
  const app = express();
  app.use(express.json());

  // No-op auth — the screener router accepts an injected middleware
  const noOpAuth: express.RequestHandler = (_req, _res, next) => next();

  app.use("/api", createScreenerRouter(makeStubProvider(mode), noOpAuth));
  return app;
}

// ---------------------------------------------------------------------------
// Test helper: start server, run test, stop server
// ---------------------------------------------------------------------------

interface TestServer {
  url: string;
  server: Server;
}

function startServer(mode: StubMode): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const app = buildTestApp(mode);
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not determine server address"));
        return;
      }
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
    server.on("error", reject);
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// 1. Provider throws — must return 503
// ---------------------------------------------------------------------------

describe("GET /screener — provider throws", () => {
  let ts: TestServer;

  before(async () => {
    ts = await startServer({
      kind: "throw",
      message: "Polygon API connection refused",
    });
  });

  after(() => stopServer(ts.server));

  it("returns HTTP 503", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    assert.equal(
      res.status,
      503,
      `Expected 503 when provider throws, got ${res.status}`,
    );
  });

  it("response Content-Type is application/json", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    assert.ok(
      res.headers.get("content-type")?.includes("application/json"),
      "Response must be JSON",
    );
  });

  it("body has error field explaining the outage", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;

    assert.ok(
      typeof body["error"] === "string" && body["error"].length > 0,
      `body.error must be a non-empty string (got ${JSON.stringify(body["error"])})`,
    );
  });

  it("body.detail contains the original error message", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(
      body["detail"],
      "Polygon API connection refused",
      "body.detail must echo the thrown error message",
    );
  });

  it("body.results is null (not an empty array)", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(
      body["results"],
      null,
      "body.results must be null when the provider is unavailable",
    );
  });

  it("body does NOT contain a stack trace", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const raw = await res.text();

    assert.ok(
      !raw.includes("at Object.") && !raw.includes("Error: "),
      "Response must not leak a stack trace to the caller",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Provider returns empty universe — must return 200 with []
// ---------------------------------------------------------------------------

describe("GET /screener — provider returns empty universe", () => {
  let ts: TestServer;

  before(async () => {
    ts = await startServer({ kind: "empty" });
  });

  after(() => stopServer(ts.server));

  it("returns HTTP 200", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    assert.equal(
      res.status,
      200,
      `Expected 200 when universe is empty, got ${res.status}`,
    );
  });

  it("body.results is an empty array", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;

    assert.ok(
      Array.isArray(body["results"]) &&
        (body["results"] as unknown[]).length === 0,
      "body.results must be [] when the universe is empty",
    );
  });

  it("body.totalScanned is 0", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(
      body["totalScanned"],
      0,
      `body.totalScanned must be 0 (got ${body["totalScanned"]})`,
    );
  });

  it("body.totalQualified is 0", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(
      body["totalQualified"],
      0,
      `body.totalQualified must be 0 (got ${body["totalQualified"]})`,
    );
  });

  it("body.message explains why results are empty", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;

    assert.ok(
      typeof body["message"] === "string" && body["message"].length > 0,
      "body.message must explain the empty universe to the caller",
    );
  });

  it("body.dataFreshness is present with source and timestamp", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;
    const freshness = body["dataFreshness"] as Record<string, unknown> | null;

    assert.ok(
      freshness !== null &&
        typeof freshness["source"] === "string" &&
        typeof freshness["timestamp"] === "string",
      "body.dataFreshness must have source and timestamp",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Provider returns stocks — must return 200 with screening results
// ---------------------------------------------------------------------------

describe("GET /screener — provider returns full universe", () => {
  let ts: TestServer;

  before(async () => {
    ts = await startServer({ kind: "stocks", stocks: MOCK_STOCKS });
  });

  after(() => stopServer(ts.server));

  it("returns HTTP 200", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    assert.equal(
      res.status,
      200,
      `Expected 200 when stocks are returned, got ${res.status}`,
    );
  });

  it("body.results is an array with one entry per stock", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;

    assert.ok(
      Array.isArray(body["results"]),
      "body.results must be an array",
    );
    assert.equal(
      (body["results"] as unknown[]).length,
      MOCK_STOCKS.length,
      `body.results must have ${MOCK_STOCKS.length} entries (one per stock)`,
    );
  });

  it("body.totalScanned equals MOCK_STOCKS.length", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;

    assert.equal(
      body["totalScanned"],
      MOCK_STOCKS.length,
      `body.totalScanned must equal ${MOCK_STOCKS.length}`,
    );
  });

  it("body.totalQualified is a non-negative integer ≤ totalScanned", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;

    const qualified = body["totalQualified"] as number;
    const scanned = body["totalScanned"] as number;

    assert.ok(
      Number.isInteger(qualified) && qualified >= 0 && qualified <= scanned,
      `body.totalQualified must be 0–${scanned} (got ${qualified})`,
    );
  });

  it("each result has qualified, symbol, and filterResults", async () => {
    const res = await fetch(`${ts.url}/api/screener`);
    const body = (await res.json()) as Record<string, unknown>;
    const results = body["results"] as Array<Record<string, unknown>>;

    for (const r of results) {
      assert.ok(
        typeof r["symbol"] === "string",
        `result.symbol must be a string (got ${JSON.stringify(r["symbol"])})`,
      );
      assert.ok(
        typeof r["qualified"] === "boolean",
        `${r["symbol"]}.qualified must be boolean`,
      );
      assert.ok(
        Array.isArray(r["filterResults"]),
        `${r["symbol"]}.filterResults must be an array`,
      );
    }
  });
});
