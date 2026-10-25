// Process-local demo sessions. Agent tokens stay on the server: never in browser props, URLs or logs.
import "server-only";
import { randomBytes } from "node:crypto";
import type { AgentToken } from "@/lib/agent-auth";
import type { StreamedEvent } from "@/lib/agent-events";
import { tidy } from "@/config/tidy";
import { AuthError } from "@/lib/auth-error";
type DemoSession = {
  owner: string;
  ownerName: string;
  parent: AgentToken;
  busy: boolean;
  revoked: boolean;
  revoking: boolean;
  tokenExpiresAt: number;
  expiresAt: number;
  controller?: AbortController;
  runPrompt?: string;
  events: StreamedEvent[];
};
const shared = globalThis as typeof globalThis & {
  tidyDemoSessions?: Map<string, DemoSession>;
  tidyMinting?: Set<string>;
};
export const sessions: Map<string, DemoSession> = (shared.tidyDemoSessions ??= new Map<
  string,
  DemoSession
>());
const minting = (shared.tidyMinting ??= new Set<string>());
export async function withMintLock<T>(owner: string, action: () => Promise<T>): Promise<T> {
  if (minting.has(owner)) throw new AuthError(400, "An agent session is already being started. Please wait.");
  minting.add(owner);
  try {
    return await action();
  } finally {
    minting.delete(owner);
  }
}
export function assertNoRunningAgent() {
  if ([...sessions.values()].some(session => session.busy || session.revoking))
    throw new AuthError(400, "Wait for Tidy to finish or revoke it before resetting sample data.");
}
export function prune() {
  for (const [key, session] of sessions)
    if (session.expiresAt < Date.now() && !session.busy && !session.revoking) sessions.delete(key);
}
export function saveSession(
  owner: string,
  ownerName: string,
  parent: AgentToken,
  expiresAt = Date.now() + tidy.sessionTtlSeconds * 1000,
) {
  prune();
  const handle = randomBytes(24).toString("hex");
  sessions.set(handle, {
    owner,
    ownerName,
    parent,
    busy: false,
    revoked: false,
    revoking: false,
    events: [],
    tokenExpiresAt: Date.now() + parent.expiresIn * 1000,
    expiresAt,
  });
  return handle;
}
export function ownedSession(handle: string, owner: string) {
  prune();
  const session = sessions.get(handle);
  if (!session || session.owner !== owner)
    throw new AuthError(401, "This demo session is unavailable. Start Tidy again.");
  return session;
}
