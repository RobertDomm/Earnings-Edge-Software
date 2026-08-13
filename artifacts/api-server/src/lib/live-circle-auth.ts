/**
 * LiveCircleAuthService
 *
 * Production implementation of ICircleAuthService using Circle OAuth 2.0.
 *
 * Flow:
 *   1. getLoginUrl() → redirect user to Circle's OAuth authorize page
 *   2. Circle redirects back to /api/auth/callback?code=...
 *   3. validateAuthCode(code) → exchange code for token, get user info,
 *      verify Space Group membership
 *   4. revalidateAccess(userId) → re-check Space Group on existing sessions
 *
 * Required env vars (set in Replit Secrets):
 *   CIRCLE_CLIENT_ID               — OAuth app client ID
 *   CIRCLE_CLIENT_SECRET           — OAuth app client secret
 *   CIRCLE_COMMUNITY_ID            — Numeric community ID
 *   CIRCLE_REQUIRED_SPACE_GROUP_ID — Space Group ID that grants access
 *   CIRCLE_API_TOKEN               — Circle API token for membership checks
 */

import type { ICircleAuthService, AuthCheckResult, CircleUser } from "./circle-auth.js";

interface CircleTokenResponse {
  access_token: string;
  token_type: string;
  scope?: string;
  // Circle may include basic user info in the token response
  community_member?: {
    id: number;
    email: string;
    name: string;
    avatar_url: string | null;
  };
}

interface CircleMeResponse {
  id: number;
  email: string;
  name: string;
  avatar_url: string | null;
}

interface CircleSpaceGroupMember {
  community_member_id: number;
  email: string;
}

export class LiveCircleAuthService implements ICircleAuthService {
  readonly mode = "live" as const;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly communityId: string;
  private readonly requiredSpaceGroupId: string;
  private readonly apiToken: string;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    communityId: string;
    requiredSpaceGroupId: string;
    apiToken: string;
  }) {
    if (!config.clientId)           throw new Error("CIRCLE_CLIENT_ID is required");
    if (!config.clientSecret)       throw new Error("CIRCLE_CLIENT_SECRET is required");
    if (!config.communityId)        throw new Error("CIRCLE_COMMUNITY_ID is required");
    if (!config.requiredSpaceGroupId) throw new Error("CIRCLE_REQUIRED_SPACE_GROUP_ID is required");
    if (!config.apiToken)           throw new Error("CIRCLE_API_TOKEN is required");

    this.clientId             = config.clientId;
    this.clientSecret         = config.clientSecret;
    this.communityId          = config.communityId;
    this.requiredSpaceGroupId = config.requiredSpaceGroupId;
    this.apiToken             = config.apiToken;
  }

  getLoginUrl(callbackUrl?: string): string {
    const params = new URLSearchParams({
      client_id:     this.clientId,
      redirect_uri:  callbackUrl ?? "",
      response_type: "code",
    });
    return `https://app.circle.so/oauth/authorize?${params}`;
  }

  async validateAuthCode(code: string, redirectUri?: string): Promise<AuthCheckResult> {
    // 1. Exchange authorization code for access token
    let tokenData: CircleTokenResponse;
    try {
      // Circle's OAuth token endpoint requires standard form-encoded parameters
      // (application/x-www-form-urlencoded), not JSON.  Sending a JSON body
      // causes a 400 / invalid_grant error even with correct credentials.
      const tokenParams = new URLSearchParams({
        client_id:     this.clientId,
        client_secret: this.clientSecret,
        code,
        grant_type:    "authorization_code",
      });
      if (redirectUri) tokenParams.set("redirect_uri", redirectUri);

      const tokenRes = await fetch("https://app.circle.so/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept":        "application/json",
        },
        body:   tokenParams.toString(),
        signal: AbortSignal.timeout(15_000),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        throw new Error(`Circle token exchange failed (${tokenRes.status}): ${text}`);
      }

      tokenData = await tokenRes.json() as CircleTokenResponse;
    } catch (err) {
      throw new Error(`Circle OAuth token exchange error: ${(err as Error).message}`);
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) throw new Error("Circle returned no access_token");

    // 2. Get current user profile
    let user: CircleUser;
    try {
      // Use community_member embedded in token if available, otherwise fetch /api/v1/me
      const cm = tokenData.community_member;
      if (cm?.email) {
        user = {
          id:        String(cm.id),
          name:      cm.name ?? cm.email,
          email:     cm.email,
          avatarUrl: cm.avatar_url ?? null,
        };
      } else {
        const meRes = await fetch("https://app.circle.so/api/v1/me", {
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept":        "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!meRes.ok) throw new Error(`Circle /api/v1/me failed (${meRes.status})`);
        const me = await meRes.json() as CircleMeResponse;
        user = {
          id:        String(me.id),
          name:      me.name ?? me.email,
          email:     me.email,
          avatarUrl: me.avatar_url ?? null,
        };
      }
    } catch (err) {
      throw new Error(`Failed to fetch Circle user profile: ${(err as Error).message}`);
    }

    // 3. Verify Space Group membership using the community API token
    const authorized = await this.checkSpaceGroupMembership(user.email);

    return {
      authenticated: true,
      authorized,
      user: authorized ? user : undefined,
    };
  }

  async revalidateAccess(userId: string): Promise<boolean> {
    // Re-check by looking up the member by ID and confirming space group
    try {
      const res = await fetch(
        `https://app.circle.so/api/v1/community_members/${userId}` +
        `?community_id=${encodeURIComponent(this.communityId)}`,
        {
          headers: {
            "Authorization": `Token ${this.apiToken}`,
            "Accept":        "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!res.ok) return false;
      const member = await res.json() as { email?: string };
      if (!member.email) return false;
      return this.checkSpaceGroupMembership(member.email);
    } catch {
      // Network error — fail open to avoid kicking valid users on transient errors
      return true;
    }
  }

  /**
   * Returns true if the given email belongs to a member of the required Space Group.
   * Uses the Circle community API token (not the OAuth access token).
   */
  private async checkSpaceGroupMembership(email: string): Promise<boolean> {
    try {
      const url =
        `https://app.circle.so/api/v1/space_group_members` +
        `?community_id=${encodeURIComponent(this.communityId)}` +
        `&space_group_id=${encodeURIComponent(this.requiredSpaceGroupId)}` +
        `&email=${encodeURIComponent(email)}`;

      const res = await fetch(url, {
        headers: {
          "Authorization": `Token ${this.apiToken}`,
          "Accept":        "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 404) return false; // member not found
      if (!res.ok) {
        // Unexpected error — log and deny
        return false;
      }

      const data = await res.json() as
        | CircleSpaceGroupMember
        | CircleSpaceGroupMember[]
        | { records?: CircleSpaceGroupMember[] };

      // Handle various response shapes Circle might return
      if (Array.isArray(data)) return data.length > 0;
      if ("records" in data)   return (data.records?.length ?? 0) > 0;
      if ("email" in data)     return true; // single record = member exists
      return false;
    } catch {
      return false;
    }
  }
}
