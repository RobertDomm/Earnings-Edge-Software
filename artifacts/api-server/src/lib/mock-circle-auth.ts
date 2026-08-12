/**
 * MockCircleAuthService
 *
 * Development-only implementation of ICircleAuthService.
 * Simulates three authorization scenarios without real Circle credentials.
 *
 * IMPORTANT: This service is BLOCKED when NODE_ENV=production.
 * It is impossible to use mock auth in production by design.
 *
 * Controlled by environment variable:
 *   CIRCLE_AUTH_MODE=mock  (default in development)
 *
 * Usage during development — append ?scenario= to the login URL:
 *   ?scenario=authorized    → ACCESS GRANTED  (Circle member + Space Group)
 *   ?scenario=unauthorized  → ACCESS DENIED   (Circle member, no Space Group)
 *   ?scenario=anonymous     → ACCESS DENIED   (not a Circle member)
 *
 * To connect real Circle OAuth, implement LiveCircleAuthService and set
 * CIRCLE_AUTH_MODE=live along with the required credentials.
 */

import type { ICircleAuthService, AuthCheckResult, CircleUser } from "./circle-auth.js";
import { LiveCircleAuthService } from "./live-circle-auth.js";

const MOCK_AUTHORIZED_USER: CircleUser = {
  id: "mock-user-001",
  name: "Authorized Member",
  email: "member@example.com",
  avatarUrl: null,
};

const MOCK_UNAUTHORIZED_USER: CircleUser = {
  id: "mock-user-002",
  name: "Circle Member (No Access)",
  email: "nomember@example.com",
  avatarUrl: null,
};

export class MockCircleAuthService implements ICircleAuthService {
  readonly mode = "mock" as const;

  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "MockCircleAuthService cannot be used in production. " +
          "Set CIRCLE_AUTH_MODE=live and provide real Circle credentials."
      );
    }
  }

  getLoginUrl(_callbackUrl?: string): string {
    // In mock mode, the login URL points back to our own callback
    // with the scenario baked in as the "code" parameter.
    // Frontends can also pass ?scenario= directly to /api/auth/login.
    return "/api/auth/login?scenario=authorized";
  }

  async validateAuthCode(code: string): Promise<AuthCheckResult> {
    // In mock mode, the "code" is the scenario name
    const scenario = code || "anonymous";

    switch (scenario) {
      case "authorized":
        return {
          authenticated: true,
          authorized: true,
          user: MOCK_AUTHORIZED_USER,
        };
      case "unauthorized":
        return {
          authenticated: true,
          authorized: false,
          user: MOCK_UNAUTHORIZED_USER,
        };
      case "anonymous":
      default:
        return {
          authenticated: false,
          authorized: false,
        };
    }
  }

  async revalidateAccess(userId: string): Promise<boolean> {
    // Mock: authorized user stays authorized
    return userId === MOCK_AUTHORIZED_USER.id;
  }
}

/**
 * Factory: create the appropriate CircleAuthService based on environment.
 *
 * CIRCLE_AUTH_MODE values:
 *   mock  → MockCircleAuthService (development only)
 *   live  → LiveCircleAuthService (requires credentials — not yet implemented)
 */
export function createCircleAuthService(): ICircleAuthService {
  const mode = process.env.CIRCLE_AUTH_MODE ?? "mock";

  if (process.env.NODE_ENV === "production" && mode === "mock") {
    throw new Error(
      "CIRCLE_AUTH_MODE=mock is not allowed in production. " +
        "Set CIRCLE_AUTH_MODE=live and provide Circle credentials."
    );
  }

  if (mode === "mock") {
    return new MockCircleAuthService();
  }

  // LIVE MODE — uses LiveCircleAuthService with real Circle OAuth
  return new LiveCircleAuthService({
    clientId:             process.env.CIRCLE_CLIENT_ID!,
    clientSecret:         process.env.CIRCLE_CLIENT_SECRET!,
    communityId:          process.env.CIRCLE_COMMUNITY_ID!,
    requiredSpaceGroupId: process.env.CIRCLE_REQUIRED_SPACE_GROUP_ID!,
    apiToken:             process.env.CIRCLE_API_TOKEN!,
  });
}
