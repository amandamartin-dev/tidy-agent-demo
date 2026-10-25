"use server";
import { headers } from "next/headers";
import { decodeJwt } from "jose";
import { checkRecentAuth, withAuth } from "@workos-inc/authkit-nextjs";
import { tidy } from "@/config/tidy";
import {
  mintTidy,
  revoke,
  getSession,
  verifyAgentJwt,
  assertSessionActive,
  validateAgentToken,
} from "@/lib/agent-auth";
import { requirePermission } from "@/lib/require-permission";
import { AuthError } from "@/lib/auth-error";
import { appOrigin } from "@/lib/api";
import { ownedSession, prune, saveSession, sessions, withMintLock } from "@/lib/demo-sessions";
import { agentCall, type ApiResult } from "@/lib/agent-http";

// What the identity card shows: only the claims it renders and WorkOS's view of the session.
export type AgentIdentity = {
  claims: {
    sub: string;
    sub_profile: string;
    act_sub: string | null;
    org_id: string;
    permissions: string[];
    intent: string | null;
    exp: number | null;
  };
  actsForName: string;
  status: "active" | "revoked" | "expired" | "invalid" | "unverified";
  checkedAt: string;
};

export type RevokeMoment = {
  signatureVerifiesLocally: boolean;
  tokenExpiresAt: number | null;
  sessionStatus: string;
  revokedAt: string | null;
  apiStatus: number;
  apiError: string;
};
async function human() {
  if ((await headers()).has("authorization"))
    throw new AuthError(401, "Use the hosted human session for browser controls.");
  await requirePermission("customers:delete", new Request(`${appOrigin()}/`));
  const auth = await withAuth();
  if (!auth.user || !auth.accessToken) throw new AuthError(401, "Sign in first.");
  return auth as typeof auth & { user: NonNullable<typeof auth.user>; accessToken: string };
}
function safeError(error: unknown) {
  if (error instanceof AuthError) return { error: error.message };
  // Do not serialize SDK errors: they can contain credentials or personal data.
  return { error: "The operation could not be verified. Check the session and try again." };
}
async function ensureNoLiveSession(owner: string) {
  prune();
  for (const session of sessions.values()) {
    if (session.owner !== owner || session.revoked) continue;
    const state = await getSession(session.parent.sessionId);
    session.revoked = state.status === "revoked";
    if (state.status === "active") {
      if (session.busy || session.revoking || session.tokenExpiresAt > Date.now())
        throw new AuthError(400, "Revoke your current Tidy session before starting another.");
      await revoke(session.parent.sessionId); // Retire the backing session before replacing an expired token.
      session.revoked = true;
    }
  }
}
async function checkedMint(accessToken: string, owner: string, prompt: string) {
  // The prompt becomes the token's `intent`, so downstream logs can record why the agent acted.
  const token = await mintTidy(accessToken, prompt || undefined);
  try {
    const claims = await verifyAgentJwt(token.accessToken);
    if (claims.act.sub !== owner || claims.sid !== token.sessionId || claims.sub !== token.agentInstanceId)
      throw new AuthError(503, "Unexpected delegated identity.");
    return token;
  } catch (error) {
    await revoke(token.sessionId);
    throw error;
  }
}
export async function startTidy(prompt = "") {
  try {
    const auth = await human();
    // Delegating to an agent is a sensitive action, so require a recent sign-in (step-up).
    // checkRecentAuth reads auth_time and fails closed; /login sends the same maxAge so AuthKit
    // forces a fresh sign-in. https://workos.com/blog/step-up-authentication-ai-agents
    // https://github.com/workos/authkit-nextjs#re-authentication
    const { isStale } = await checkRecentAuth({ maxAge: tidy.sessionTtlSeconds });
    if (isStale)
      return {
        error: "WorkOS requires a recent sign-in before delegation. Sign in again, then retry.",
        reauthRequired: true,
      };
    return await withMintLock(auth.user.id, async () => {
      await ensureNoLiveSession(auth.user.id);
      const intent = prompt.replace(/\s+/g, " ").trim();
      const token = await checkedMint(
        auth.accessToken,
        auth.user.id,
        intent.length > 200 ? `${intent.slice(0, 199)}…` : intent,
      );
      try {
        const state = await getSession(token.sessionId);
        const handle = saveSession(
          auth.user.id,
          auth.user.firstName || "Human",
          token,
          Date.parse(state.expiresAt),
        );
        return { handle };
      } catch (error) {
        await revoke(token.sessionId);
        throw error;
      }
    });
  } catch (error) {
    return safeError(error);
  }
}
async function verifiesLocally(accessToken: string): Promise<boolean> {
  try {
    await verifyAgentJwt(accessToken);
    return true;
  } catch {
    return false;
  }
}
export async function revokeTidy(handle: string) {
  try {
    const auth = await human();
    const session = ownedSession(handle, auth.user.id);
    if (session.revoking) throw new AuthError(400, "Revocation is already in progress.");
    session.revoking = true;
    try {
      const token = session.parent.accessToken;
      await revoke(session.parent.sessionId); // Idempotent: a second revoke keeps the original revoked_at.
      session.revoked = true;
      session.controller?.abort(new Error("Agent revoked"));
      const signatureVerifiesLocally = await verifiesLocally(token);
      const state = await getSession(session.parent.sessionId);
      let probe: ApiResult<unknown>;
      try {
        probe = await agentCall<unknown>(appOrigin(), token, "/api/customers");
      } catch {
        probe = { ok: false, status: 0, raw: "", data: {} };
      }
      if (state.status === "active" || probe.status !== 401)
        throw new AuthError(503, "Revocation has not been fully verified. Retry Revoke.");
      let tokenExpiresAt: number | null = null;
      try {
        tokenExpiresAt = decodeJwt(token).exp ?? null;
      } catch {
        /* display only */
      }
      const moment: RevokeMoment = {
        signatureVerifiesLocally,
        tokenExpiresAt,
        sessionStatus: state.status,
        revokedAt: state.revokedAt,
        apiStatus: probe.status,
        apiError: probe.ok ? "" : (probe.data.error ?? ""),
      };
      return { moment };
    } finally {
      session.revoking = false;
    }
  } catch (error) {
    return safeError(error);
  }
}

// Identity card data, decoded on the server so the token never reaches the browser. The status
// pill comes from WorkOS's session record; if that call fails the card shows "unverified".
export async function agentIdentity() {
  try {
    const auth = await human();
    prune();
    const entry = [...sessions.entries()].reverse().find(([, session]) => session.owner === auth.user.id);
    if (!entry) return { empty: true as const };
    const [handle, session] = entry;
    const token = session.parent.accessToken;
    // decodeJwt doesn't verify anything; display only. Trust decisions use verifyAgentJwt.
    const raw = decodeJwt(token) as Record<string, unknown>;
    let claims: Awaited<ReturnType<typeof verifyAgentJwt>> | null = null;
    try {
      claims = await verifyAgentJwt(token);
    } catch {
      /* an expired or invalid token is reported as "expired" below */
    }
    let status: AgentIdentity["status"];
    try {
      // One session lookup per refresh; its result feeds both the pill and the liveness check.
      const state = await getSession(session.parent.sessionId);
      session.revoked = state.status === "revoked";
      status = state.status;
      if (status === "active") {
        if (session.tokenExpiresAt <= Date.now() || !claims) status = "expired";
        else {
          try {
            assertSessionActive(state, claims);
            await validateAgentToken(token);
          } catch (error) {
            status = error instanceof AuthError && error.status === 401 ? "invalid" : "unverified";
          }
        }
      }
    } catch {
      status = "unverified";
    }
    // The guide documents intent as { text }; the validate reference shows a string. Accept both.
    const intent = raw.intent as { text?: unknown } | string | undefined;
    const act = raw.act as { sub?: unknown } | undefined;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const identity: AgentIdentity = {
      claims: {
        sub: text(raw.sub),
        sub_profile: text(raw.sub_profile),
        act_sub: typeof act?.sub === "string" ? act.sub : null,
        org_id: text(raw.org_id),
        permissions: Array.isArray(raw.permissions)
          ? raw.permissions.filter((p): p is string => typeof p === "string")
          : [],
        intent: typeof intent === "string" ? intent : typeof intent?.text === "string" ? intent.text : null,
        exp: typeof raw.exp === "number" ? raw.exp : null,
      },
      actsForName: session.ownerName,
      status,
      checkedAt: new Date().toISOString(),
    };
    return { handle, identity, busy: session.busy, runPrompt: session.runPrompt, events: session.events };
  } catch (error) {
    return safeError(error);
  }
}
