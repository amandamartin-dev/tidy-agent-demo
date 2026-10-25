import "server-only";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AuthError } from "@/lib/auth-error";
import { getWorkOS, requiredEnv } from "@/lib/workos";

export type AgentToken = {
  accessToken: string;
  expiresIn: number;
  agentInstanceId: string;
  sessionId: string;
  permissions: string[];
};

type AgentSession = {
  id: string;
  agentInstanceId: string;
  status: "active" | "revoked" | "expired";
  expiresAt: string;
  revokedAt: string | null;
};

function tokenResult(
  token: Awaited<ReturnType<ReturnType<typeof getWorkOS>["agents"]["mintToken"]>>,
): AgentToken {
  // Deliberately discard the refresh token: this demo uses short-lived sessions.
  return {
    accessToken: token.accessToken,
    expiresIn: token.expiresIn,
    agentInstanceId: token.agentInstanceId,
    sessionId: token.agentInstanceSessionId,
    permissions: token.permissions,
  };
}

// Mint a user_delegated token from the admin's session. WorkOS sets `permissions` to the admin's
// permissions intersected with the blueprint ceiling; `act.sub` is the admin and `sub` the agent.
// `intent` is echoed into the token, not stored by WorkOS.
// https://workos.com/docs/reference/agents/blueprint#mint-an-agent-token
export async function mintTidy(userAccessToken: string, intent?: string): Promise<AgentToken> {
  return tokenResult(
    await getWorkOS().agents.mintToken({
      agentBlueprintId: requiredEnv("WORKOS_AGENT_BLUEPRINT_ID"),
      type: "user_delegated",
      userAccessToken,
      ...(intent ? { intent } : {}),
    }),
  );
}

// Revoking invalidates the session and every token minted under it, child sessions included, and
// is idempotent. Tokens already issued still verify locally until `exp`, which is why
// requirePermission also calls assertAgentLive.
// https://workos.com/docs/reference/agents/session#revoke-an-agent-instance-session
export async function revoke(sessionId: string): Promise<void> {
  await getWorkOS().agents.revokeInstanceSession(sessionId);
}

// Called on every request: a valid signature says nothing about whether the session is live.
export async function getSession(sid: string): Promise<AgentSession> {
  const session = await getWorkOS().agents.getInstanceSession(sid);
  return {
    id: session.id,
    agentInstanceId: session.agentInstanceId,
    status: session.status,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
  };
}

interface AgentClaims extends JWTPayload {
  sub: string;
  sid: string;
  sub_profile: "ai_agent";
  agent_blueprint_id: string;
  org_id: string;
  permissions: string[];
  act: { sub: string; sub_profile: "user" };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

// Checks signature (JWKS), iss, aud, typ and exp against configured values, never values taken
// from the token. Agent and user tokens share keys and audience, so this proves "signed", not
// "agent" or "live"; the claim checks below and assertAgentLive cover those.
// WORKOS_AGENT_ISSUER comes from the AuthKit discovery document and can differ from the user-token issuer.
// https://workos.com/docs/authkit/agent-blueprints#agent-token-claims
export async function verifyAgentJwt(accessToken: string): Promise<AgentClaims> {
  jwks ??= createRemoteJWKSet(
    new URL(getWorkOS().userManagement.getJwksUrl(requiredEnv("WORKOS_CLIENT_ID"))),
  );
  const { payload } = await jwtVerify<AgentClaims>(accessToken, jwks, {
    issuer: requiredEnv("WORKOS_AGENT_ISSUER"),
    audience: requiredEnv("WORKOS_CLIENT_ID"),
    algorithms: ["RS256"],
    typ: "at+jwt",
    // Requiring `act` rejects autonomous instance tokens; Tidy only acts for a human.
    requiredClaims: [
      "iss",
      "aud",
      "sub",
      "sid",
      "exp",
      "iat",
      "sub_profile",
      "agent_blueprint_id",
      "org_id",
      "permissions",
      "act",
    ],
  });
  // User tokens omit sub_profile or set it to "user"; this is what separates an agent caller from a human.
  if (
    payload.sub_profile !== "ai_agent" ||
    typeof payload.sub !== "string" ||
    typeof payload.sid !== "string" ||
    payload.agent_blueprint_id !== requiredEnv("WORKOS_AGENT_BLUEPRINT_ID") ||
    payload.org_id !== requiredEnv("WORKOS_ORGANIZATION_ID") ||
    !payload.act ||
    typeof payload.act.sub !== "string" ||
    payload.act.sub_profile !== "user" ||
    !Array.isArray(payload.permissions) ||
    !payload.permissions.every(permission => typeof permission === "string")
  ) {
    throw new AuthError(401, "Invalid delegated Tidy token.");
  }
  return payload;
}

// Liveness checks fail closed: any WorkOS or network error denies access. The session record
// catches revocation and expiry; /tokens/validate also confirms the blueprint and that the
// delegating admin's session is still active. The Node SDK doesn't wrap that endpoint yet.
// https://workos.com/docs/reference/agents/blueprint#validate-an-agent-token
export function assertSessionActive(session: AgentSession, claims: AgentClaims): void {
  if (
    session.agentInstanceId !== claims.sub ||
    session.status !== "active" ||
    !(Date.parse(session.expiresAt) > Date.now())
  ) {
    throw new AuthError(401, "Agent session is revoked or expired.");
  }
}

export async function validateAgentToken(accessToken: string): Promise<void> {
  const response = await fetch(
    `https://api.workos.com/agents/blueprints/${encodeURIComponent(requiredEnv("WORKOS_AGENT_BLUEPRINT_ID"))}/tokens/validate`,
    {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${requiredEnv("WORKOS_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agent_access_token: accessToken }),
    },
  );
  if ([400, 401, 403, 404].includes(response.status))
    throw new AuthError(401, "Agent delegation is no longer valid.");
  if (!response.ok) throw new AuthError(503, "WorkOS could not verify the agent session. Access denied.");
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null || !("valid" in data) || data.valid !== true)
    throw new AuthError(401, "Agent delegation is no longer valid.");
}

export async function assertAgentLive(accessToken: string, claims: AgentClaims): Promise<void> {
  // getSession() status alone would catch revocation; /tokens/validate additionally checks the delegating human's session.
  assertSessionActive(await getSession(claims.sid), claims);
  await validateAgentToken(accessToken);
}
