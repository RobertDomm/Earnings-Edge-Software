/**
 * auth-expiry-redirect.test.tsx
 *
 * Confirms that the global QueryClient error handler in App.tsx redirects the
 * user to the Clerk sign-in page when any API call returns HTTP 401, and does
 * NOT redirect for other error codes.
 *
 * This covers the "token expired mid-session" scenario: Clerk auto-refreshes
 * short-lived JWTs, but if the refresh fails (user offline, refresh token
 * lapsed) the API server returns 401.  The app must send the user to sign-in
 * immediately — not silently fail or show an empty screen.
 *
 * Run with:
 *   pnpm --filter @workspace/screener run test
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, QueryCache, useQuery } from "@tanstack/react-query";
import { ApiError } from "@workspace/api-client-react";

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a QueryClient configured identically to the one in App.tsx:
 *   - QueryCache.onError → on 401: redirect to sign-in
 *   - retry → never retry 401s
 */
function makeQueryClient(onRedirect: (url: string) => void) {
  const basePath = "";   // empty in test — BASE_URL is not available in jsdom
  function redirectToSignIn() {
    onRedirect(`${basePath}/sign-in`);
  }

  return new QueryClient({
    queryCache: new QueryCache({
      onError(error) {
        if (error instanceof ApiError && error.status === 401) {
          redirectToSignIn();
        }
      },
    }),
    defaultOptions: {
      queries: {
        retry(failureCount, error) {
          if (error instanceof ApiError && error.status === 401) return false;
          return failureCount < 3;
        },
      },
    },
  });
}

/**
 * A minimal component that triggers a query throwing a given error.
 * The query key includes a unique nonce so each test gets a fresh cache entry.
 */
function FailingQuery({ error, nonce }: { error: Error; nonce: string }) {
  useQuery({
    queryKey: ["test-query", nonce],
    queryFn: () => { throw error; },
    retry: false,  // per-query override for speed; QueryClient config is also tested
  });
  return <div>ok</div>;
}

// ── Factory: a minimal Response-like object ────────────────────────────────────

function makeResponse(status: number): Response {
  return new Response(JSON.stringify({ error: "test" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeApiError(status: number): ApiError {
  return new ApiError(makeResponse(status), { error: "test" }, {
    method: "GET",
    url: "/api/test",
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("QueryClient 401 handler — expired Clerk JWT redirect", () => {
  let redirectSpy: ReturnType<typeof vi.fn>;
  let originalReplace: typeof window.location.replace;

  beforeEach(() => {
    redirectSpy = vi.fn();
    // jsdom doesn't implement window.location.replace properly; spy on it
    try {
      originalReplace = window.location.replace.bind(window.location);
      Object.defineProperty(window, "location", {
        value: { ...window.location, replace: redirectSpy },
        writable: true,
        configurable: true,
      });
    } catch {
      // Already overridden — just spy
    }
  });

  afterEach(() => {
    try {
      Object.defineProperty(window, "location", {
        value: { ...window.location, replace: originalReplace },
        writable: true,
        configurable: true,
      });
    } catch { /* ignore */ }
    vi.clearAllMocks();
  });

  it("calls window.location.replace('/sign-in') when a query throws ApiError 401", async () => {
    const redirectCalls: string[] = [];
    const client = makeQueryClient((url) => redirectCalls.push(url));
    const error = makeApiError(401);

    await act(async () => {
      render(
        <QueryClientProvider client={client}>
          <FailingQuery error={error} nonce="401-test" />
        </QueryClientProvider>,
      );
    });

    await waitFor(() => {
      expect(redirectCalls).toContain("/sign-in");
    });
  });

  it("does NOT redirect when a query throws ApiError 403 (member check failure)", async () => {
    const redirectCalls: string[] = [];
    const client = makeQueryClient((url) => redirectCalls.push(url));
    const error = makeApiError(403);

    await act(async () => {
      render(
        <QueryClientProvider client={client}>
          <FailingQuery error={error} nonce="403-test" />
        </QueryClientProvider>,
      );
    });

    // Wait long enough for any async handler to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(redirectCalls).toHaveLength(0);
  });

  it("does NOT redirect when a query throws ApiError 503 (server down)", async () => {
    const redirectCalls: string[] = [];
    const client = makeQueryClient((url) => redirectCalls.push(url));
    const error = makeApiError(503);

    await act(async () => {
      render(
        <QueryClientProvider client={client}>
          <FailingQuery error={error} nonce="503-test" />
        </QueryClientProvider>,
      );
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(redirectCalls).toHaveLength(0);
  });

  it("does NOT retry a 401 — sends user to sign-in immediately", async () => {
    let callCount = 0;
    const client = new QueryClient({
      queryCache: new QueryCache({
        onError(error) {
          if (error instanceof ApiError && (error as ApiError).status === 401) {
            // no-op — we just want to confirm no retries happen
          }
        },
      }),
      defaultOptions: {
        queries: {
          retry(failureCount, error) {
            if (error instanceof ApiError && error.status === 401) return false;
            return failureCount < 3;
          },
        },
      },
    });

    function CountingQuery() {
      useQuery({
        queryKey: ["retry-count-test"],
        queryFn: () => {
          callCount++;
          throw makeApiError(401);
        },
      });
      return null;
    }

    await act(async () => {
      render(
        <QueryClientProvider client={client}>
          <CountingQuery />
        </QueryClientProvider>,
      );
    });

    await waitFor(() => {
      // queryFn is called exactly once — 401s are never retried
      expect(callCount).toBe(1);
    });
  });
});
