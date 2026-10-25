import "server-only";
import type { CustomerPermission } from "@/config/tidy";
import { tidy } from "@/config/tidy";
import { demo } from "@/demo.config";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { errors } from "jose";
import { assertAgentLive, verifyAgentJwt } from "@/lib/agent-auth";
import { AuthError } from "@/lib/auth-error";
import { getWorkOS, requiredEnv } from "@/lib/workos";

export type Actor = {
  kind: "human" | "agent";
  label: string;
  onBehalfOf: string | null;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  organizationId?: string;
  intent?: unknown;
};

export async function requirePermission(permission: CustomerPermission, request: Request): Promise<Actor> {
  const authorization = request.headers.get("authorization");
  // A Bearer header is always treated as an agent token and never falls back to the cookie.
  if (authorization !== null) {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) throw new AuthError(401, "A valid Bearer agent token is required.");
    try {
      const claims = await verifyAgentJwt(match[1]);
      await assertAgentLive(match[1], claims);
      const ceiling = [...tidy.ceiling];
      if (claims.permissions.some(granted => !ceiling.includes(granted as CustomerPermission))) {
        throw new AuthError(403, "Token exceeds this app's configured Tidy ceiling.", { ceiling });
      }
      // Enforcement happens here, not at WorkOS: permissions were fixed at mint, and Tidy's ceiling
      // leaves out customers:delete, so the delete route returns 403 even for an admin's agent.
      if (!claims.permissions.includes(permission)) {
        throw new AuthError(403, `Tidy cannot ${permission}. Its ceiling is ${ceiling.join(", ")}.`, {
          missingPermission: permission,
          ceiling,
          grantedPermissions: claims.permissions,
        });
      }
      const human = await getWorkOS().userManagement.getUser(claims.act.sub);
      // Display name from demo.config.ts; tidy.name stays the blueprint name the setup script matches on.
      return {
        kind: "agent",
        label: demo.agentDisplayName,
        onBehalfOf: human.firstName || "Human",
        userId: claims.act.sub,
        agentId: claims.sub,
        sessionId: claims.sid,
        organizationId: claims.org_id,
        intent: claims.intent,
      };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) {
        throw new AuthError(401, "Invalid or expired agent token.");
      }
      throw new AuthError(503, "Agent authorization could not be verified. Access denied.");
    }
  }

  // AuthKit verifies the sealed browser session and refreshes it as needed.
  const auth = await withAuth();
  if (!auth.user) throw new AuthError(401, "Sign in before accessing customers.");
  if (auth.organizationId !== requiredEnv("WORKOS_ORGANIZATION_ID"))
    throw new AuthError(403, "This session is outside the demo organization.");
  if (!auth.permissions?.includes(permission)) {
    throw new AuthError(403, `Your session does not grant ${permission}.`, { missingPermission: permission });
  }
  return {
    kind: "human",
    label: auth.user.firstName || "Human",
    onBehalfOf: null,
    userId: auth.user.id,
    sessionId: auth.sessionId,
    organizationId: auth.organizationId,
  };
}
