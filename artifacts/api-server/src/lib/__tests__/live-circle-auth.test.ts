/**
 * live-circle-auth.test.ts
 *
 * Unit tests for LiveCircleAuthService — the production Circle OAuth
 * implementation.  All outbound network calls are replaced with synchronous
 * stubs so no real HTTP traffic is made during this suite.
 *
 * Scenarios covered:
 *   1. Member path  — token exchange + /me + space-group check all succeed:
 *      validateAuthCode returns { authenticated: true, authorized: true, user }
 *   2. Non-member path — token/me succeed but space-group returns 404:
 *      validateAuthCode returns { authenticated: true, authorized: false, user: undefined }
 *   3. Non-member path — space-group returns empty array (no records):
 *      validateAuthCode returns { authenticated: true, authorized: false, user: undefined }
 *   4. Token exchange fails (non-2xx from Circle) → throws with a clear message
 *   5. getLoginUrl builds correct Circle OAuth URL with client_id + redirect_uri
 *   6. community_member embedded in token response avoids the extra /me round-trip
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test
 */

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { LiveCircleAuthService } from "../live-circle-auth.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal service instance with fake-but-valid credentials. */
function makeService(): LiveCircleAuthService {
  return new LiveCircleAuthService({
    clientId:             "test-client-id",
    clientSecret:         "test-client-secret",
    communityId:          "99999",
    requiredSpaceGroupId: "12345",
    apiToken:             "test-api-token",
  });
}

/**
 * Create a minimal Response-like object that satisfies the Fetch API shape
 * used by LiveCircleAuthService.
 */
function mockResponse(
  status: number,
  body: unknown,
): Response {
  const json = JSON.stringify(body);
  return new Response(json, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Member record returned by the space-group endpoint. */
const SPACE_GROUP_MEMBER = {
  community_member_id: 1001,
  email: "member@example.com",
};

/** Resolved user data expected in AuthCheckResult for a member. */
const EXPECTED_USER = {
  id: "1001",
  name: "Alice Member",
  email: "member@example.com",
  avatarUrl: "https://cdn.example.com/avatar.jpg",
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("LiveCircleAuthService — getLoginUrl", () => {
  it("includes client_id and redirect_uri in the Circle authorize URL", () => {
    const svc = makeService();
    const url = svc.getLoginUrl("https://myapp.example.com/api/auth/callback");
    assert.ok(
      url.startsWith("https://app.circle.so/oauth/authorize"),
      `Login URL must point to Circle OAuth (got: ${url})`,
    );
    assert.ok(
      url.includes("client_id=test-client-id"),
      `Login URL must include client_id (got: ${url})`,
    );
    assert.ok(
      url.includes(encodeURIComponent("https://myapp.example.com/api/auth/callback")),
      `Login URL must include the redirect_uri (got: ${url})`,
    );
  });
});

// ─── Token exchange request format ───────────────────────────────────────────
//
// Circle's OAuth token endpoint requires application/x-www-form-urlencoded,
// not JSON.  Sending a JSON body causes a 400 / invalid_grant error.

describe("LiveCircleAuthService — token exchange request format", () => {
  /** Captured token-exchange request (url + init). */
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  before(() => {
    let call = 0;
    (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
      if (call++ === 0) {
        // Capture the token exchange call before responding.
        capturedUrl  = url;
        capturedInit = init;
        return mockResponse(200, { access_token: "tok-capture", token_type: "Bearer" });
      }
      // /me fallback
      if (typeof url === "string" && url.includes("/me")) {
        return mockResponse(200, {
          id: 9999, email: "x@x.com", name: "X", avatar_url: null,
        });
      }
      // space-group
      return mockResponse(200, []);
    };
  });

  after(() => { mock.restoreAll(); });

  it("POSTs to the Circle token endpoint", async () => {
    const svc = makeService();
    await svc.validateAuthCode("code-format", "https://host/cb").catch(() => {});
    assert.ok(
      capturedUrl?.includes("app.circle.so/oauth/token"),
      `Token request must target the Circle token endpoint (got: ${capturedUrl})`,
    );
    assert.equal(capturedInit?.method, "POST", "Token request must use POST");
  });

  it("sends Content-Type: application/x-www-form-urlencoded (not JSON)", async () => {
    const svc = makeService();
    await svc.validateAuthCode("code-format", "https://host/cb").catch(() => {});
    const ct = (capturedInit?.headers as Record<string, string>)?.["Content-Type"];
    assert.ok(
      ct?.includes("application/x-www-form-urlencoded"),
      `Token request Content-Type must be application/x-www-form-urlencoded (got: ${ct})`,
    );
    assert.ok(
      !ct?.includes("application/json"),
      `Token request must NOT use application/json (got: ${ct})`,
    );
  });

  it("encodes the body as URL-encoded parameters (not JSON)", async () => {
    const svc = makeService();
    await svc.validateAuthCode("code-format", "https://host/cb").catch(() => {});
    const body = capturedInit?.body as string;
    // Body must be parseable as URLSearchParams with the right fields.
    const params = new URLSearchParams(body);
    assert.equal(params.get("grant_type"),    "authorization_code",
      "body must include grant_type=authorization_code");
    assert.equal(params.get("client_id"),     "test-client-id",
      "body must include client_id");
    assert.equal(params.get("code"),          "code-format",
      "body must include the authorization code");
    assert.equal(params.get("redirect_uri"),  "https://host/cb",
      "body must include the redirect_uri");
    // Ensure it is NOT JSON.
    assert.throws(() => JSON.parse(body),
      "Token request body must not be valid JSON");
  });
});

// ─── validateAuthCode — member path ───────────────────────────────────────────

describe("LiveCircleAuthService — validateAuthCode — member", () => {
  let fetchMock: ReturnType<typeof mock.fn>;
  let callCount = 0;

  before(() => {
    /**
     * Three-call sequence for the member scenario:
     *   call 0 → POST /oauth/token       → returns access_token (no embedded user)
     *   call 1 → GET  /api/v1/me         → returns user profile
     *   call 2 → GET  /api/v1/space_group_members → returns single member record
     */
    fetchMock = mock.fn(async (_url: string) => {
      const call = callCount++;
      if (call === 0) {
        // Token exchange
        return mockResponse(200, { access_token: "tok-abc123", token_type: "Bearer" });
      }
      if (call === 1) {
        // /me endpoint
        return mockResponse(200, {
          id: 1001,
          email: EXPECTED_USER.email,
          name: EXPECTED_USER.name,
          avatar_url: EXPECTED_USER.avatarUrl,
        });
      }
      // Space-group membership: single record → member found
      return mockResponse(200, SPACE_GROUP_MEMBER);
    });
    // Replace global fetch for the duration of this suite
    (globalThis as any).fetch = fetchMock;
  });

  after(() => {
    mock.restoreAll();
  });

  it("returns authenticated: true", async () => {
    callCount = 0;
    const svc = makeService();
    const result = await svc.validateAuthCode("auth-code-member", "https://host/callback");
    assert.equal(result.authenticated, true, "Member must be authenticated");
  });

  it("returns authorized: true", async () => {
    callCount = 0;
    const svc = makeService();
    const result = await svc.validateAuthCode("auth-code-member", "https://host/callback");
    assert.equal(result.authorized, true, "Space Group member must be authorized");
  });

  it("returns user with correct id, name, email, avatarUrl", async () => {
    callCount = 0;
    const svc = makeService();
    const result = await svc.validateAuthCode("auth-code-member", "https://host/callback");
    assert.ok(result.user, "Member result must include a user object");
    assert.equal(result.user!.id,        EXPECTED_USER.id);
    assert.equal(result.user!.name,      EXPECTED_USER.name);
    assert.equal(result.user!.email,     EXPECTED_USER.email);
    assert.equal(result.user!.avatarUrl, EXPECTED_USER.avatarUrl);
  });
});

// ─── validateAuthCode — non-member (space-group 404) ─────────────────────────

describe("LiveCircleAuthService — validateAuthCode — non-member (404)", () => {
  let fetchMock: ReturnType<typeof mock.fn>;
  let callCount = 0;

  before(() => {
    fetchMock = mock.fn(async (_url: string) => {
      const call = callCount++;
      if (call === 0) {
        return mockResponse(200, { access_token: "tok-nonmember", token_type: "Bearer" });
      }
      if (call === 1) {
        return mockResponse(200, {
          id: 2002,
          email: "nonmember@example.com",
          name: "Non Member",
          avatar_url: null,
        });
      }
      // Space-group check: 404 — not in the group
      return mockResponse(404, { error: "not found" });
    });
    (globalThis as any).fetch = fetchMock;
  });

  after(() => {
    mock.restoreAll();
  });

  it("returns authenticated: true (they have a valid Circle account)", async () => {
    callCount = 0;
    const svc = makeService();
    const result = await svc.validateAuthCode("auth-code-nonmember", "https://host/callback");
    assert.equal(result.authenticated, true, "Non-member is still authenticated with Circle");
  });

  it("returns authorized: false (not in the required Space Group)", async () => {
    callCount = 0;
    const svc = makeService();
    const result = await svc.validateAuthCode("auth-code-nonmember", "https://host/callback");
    assert.equal(result.authorized, false, "Non-member must not be authorized");
  });

  it("does not include a user on the result", async () => {
    callCount = 0;
    const svc = makeService();
    const result = await svc.validateAuthCode("auth-code-nonmember", "https://host/callback");
    assert.equal(
      result.user,
      undefined,
      "Non-member result must not include a user (gate: user is only set when authorized)",
    );
  });
});

// ─── validateAuthCode — non-member (empty array response) ────────────────────

describe("LiveCircleAuthService — validateAuthCode — non-member (empty array)", () => {
  let fetchMock: ReturnType<typeof mock.fn>;
  let callCount = 0;

  before(() => {
    fetchMock = mock.fn(async (_url: string) => {
      const call = callCount++;
      if (call === 0) {
        return mockResponse(200, { access_token: "tok-empty", token_type: "Bearer" });
      }
      if (call === 1) {
        return mockResponse(200, {
          id: 3003,
          email: "nogroup@example.com",
          name: "No Group User",
          avatar_url: null,
        });
      }
      // Space-group check: empty array → no members match
      return mockResponse(200, []);
    });
    (globalThis as any).fetch = fetchMock;
  });

  after(() => {
    mock.restoreAll();
  });

  it("returns authorized: false when space-group returns an empty array", async () => {
    callCount = 0;
    const svc = makeService();
    const result = await svc.validateAuthCode("auth-code-empty", "https://host/callback");
    assert.equal(result.authorized, false, "Empty space-group array must deny authorization");
  });
});

// ─── validateAuthCode — embedded community_member in token response ───────────

describe("LiveCircleAuthService — validateAuthCode — user embedded in token", () => {
  let fetchMock: ReturnType<typeof mock.fn>;
  let callCount = 0;

  before(() => {
    fetchMock = mock.fn(async (_url: string) => {
      const call = callCount++;
      if (call === 0) {
        // Token response includes community_member — /me should NOT be fetched
        return mockResponse(200, {
          access_token: "tok-embed",
          token_type: "Bearer",
          community_member: {
            id: 4004,
            email: "embedded@example.com",
            name: "Embedded User",
            avatar_url: null,
          },
        });
      }
      // Only space-group check should be called (call 1); /me (call 1) is skipped
      return mockResponse(200, {
        community_member_id: 4004,
        email: "embedded@example.com",
      });
    });
    (globalThis as any).fetch = fetchMock;
  });

  after(() => {
    mock.restoreAll();
  });

  it("resolves the user from the token body without calling /api/v1/me", async () => {
    callCount = 0;
    const svc = makeService();
    const result = await svc.validateAuthCode("auth-code-embed", "https://host/callback");
    // Only 2 calls: token exchange + space-group (no /me)
    assert.equal(callCount, 2, `Expected 2 fetch calls (token + space-group), got ${callCount}`);
    assert.equal(result.user?.email, "embedded@example.com");
  });
});

// ─── validateAuthCode — token exchange failure ────────────────────────────────

describe("LiveCircleAuthService — validateAuthCode — token exchange failure", () => {
  let fetchMock: ReturnType<typeof mock.fn>;

  before(() => {
    fetchMock = mock.fn(async () => {
      return mockResponse(400, { error: "invalid_grant", error_description: "Code expired" });
    });
    (globalThis as any).fetch = fetchMock;
  });

  after(() => {
    mock.restoreAll();
  });

  it("throws when Circle returns a non-2xx token response", async () => {
    const svc = makeService();
    await assert.rejects(
      () => svc.validateAuthCode("bad-code", "https://host/callback"),
      (err: Error) => {
        assert.ok(
          err.message.includes("400") || err.message.toLowerCase().includes("token"),
          `Error message must reference the token failure (got: "${err.message}")`,
        );
        return true;
      },
    );
  });
});
