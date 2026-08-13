/**
 * Lightweight in-memory rate limiter middleware factory.
 *
 * Uses a fixed-window algorithm: each IP gets a fresh quota every
 * `windowMs` milliseconds.  Exceeding `max` requests in the current window
 * returns HTTP 429 with a `Retry-After` header.
 *
 * Designed to be injected as middleware into specific routes rather than
 * applied globally, so the window/limit can differ per endpoint.
 *
 * Injectable dependencies (`getNow`, `getIp`) allow unit tests to control
 * the clock and simulate specific client IPs without network overhead.
 */

import { type Request, type Response, type NextFunction } from "express";

export interface RateLimiterOptions {
  /** Length of the counting window in milliseconds. */
  windowMs: number;
  /** Maximum number of requests allowed per IP per window. */
  max: number;
  /** Override the current time (ms since epoch). Useful for tests. */
  getNow?: () => number;
  /**
   * Extract the client IP from the request.  In production, Express's
   * `req.ip` (populated by `trust proxy`) is used.  Tests inject a
   * fixed string so all requests count toward the same bucket.
   */
  getIp?: (req: Request) => string;
}

interface WindowEntry {
  count: number;
  windowStart: number;
}

export type RateLimiterMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void;

/**
 * Creates a rate-limiter middleware with its own isolated in-memory store.
 * Each call to `createRateLimiter` produces an independent counter map, so
 * different routes don't share limits.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiterMiddleware {
  const {
    windowMs,
    max,
    getNow = () => Date.now(),
    getIp = (req) => req.ip ?? req.socket?.remoteAddress ?? "unknown",
  } = opts;

  const store = new Map<string, WindowEntry>();

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const ip = getIp(req);
    const now = getNow();

    const existing = store.get(ip);
    let windowStart: number;
    let count: number;

    if (!existing || now - existing.windowStart >= windowMs) {
      // New window
      windowStart = now;
      count = 1;
    } else {
      // Within the current window
      windowStart = existing.windowStart;
      count = existing.count + 1;
    }

    store.set(ip, { count, windowStart });

    if (count > max) {
      const msUntilReset = windowStart + windowMs - now;
      const retryAfter = Math.max(1, Math.ceil(msUntilReset / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }

    next();
  };
}
