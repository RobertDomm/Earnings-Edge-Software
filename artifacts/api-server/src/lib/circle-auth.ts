/**
 * Circle Authorization Service
 *
 * This module defines the ICircleAuthService interface and related types.
 * The interface is intentionally decoupled from the dashboard — swapping in
 * real Circle OAuth only requires replacing MockCircleAuthService with a
 * LiveCircleAuthService that implements this same interface.
 *
 * To activate real Circle auth:
 *  1. Implement LiveCircleAuthService (ICircleAuthService)
 *  2. Set CIRCLE_AUTH_MODE=live in environment
 *  3. Provide: CIRCLE_CLIENT_ID, CIRCLE_CLIENT_SECRET, CIRCLE_COMMUNITY_ID,
 *              CIRCLE_REQUIRED_SPACE_GROUP_ID, CIRCLE_API_TOKEN
 *  4. Configure OAuth callback URL in Circle dashboard
 */

export interface CircleUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface AuthCheckResult {
  /** User has a valid Circle identity */
  authenticated: boolean;
  /** User belongs to the required Space Group */
  authorized: boolean;
  user?: CircleUser;
}

export interface ICircleAuthService {
  /**
   * Returns the URL to redirect the user to begin Circle OAuth.
   * In mock mode this is /api/auth/login?scenario=...
   */
  getLoginUrl(callbackUrl?: string): string;

  /**
   * Validates an OAuth authorization code, verifies Space Group membership,
   * and returns the auth result. In mock mode the "code" is the scenario name.
   */
  validateAuthCode(code: string): Promise<AuthCheckResult>;

  /**
   * Revalidates an existing session — checks that the Circle user still has
   * access to the required Space Group. Call this periodically (e.g. on each
   * protected request) to ensure revoked access takes effect quickly.
   */
  revalidateAccess(userId: string): Promise<boolean>;

  /** Authorization mode: 'mock' (development) | 'live' (production) */
  readonly mode: "mock" | "live";
}

/** What the application stores per-session after successful authorization */
export interface SessionAuthData {
  userId: string;
  user: CircleUser;
  authorizedAt: number; // unix ms
  lastRevalidatedAt: number; // unix ms
}

/** How long (ms) before we re-check Space Group membership. 15 minutes. */
export const REVALIDATION_TTL_MS = 15 * 60 * 1000;
