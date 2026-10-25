import "server-only";
import { WorkOS } from "@workos-inc/node";

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

let client: WorkOS | undefined;

// API-key operations stay on the server. Never cache authorization/liveness reads.
// https://workos.com/docs/authkit/agent-blueprints
export function getWorkOS(): WorkOS {
  return (client ??= new WorkOS(requiredEnv("WORKOS_API_KEY"), {
    clientId: requiredEnv("WORKOS_CLIENT_ID"),
    config: { cache: "no-store" },
    timeout: 15_000,
    maxRetries: 0,
  }));
}
