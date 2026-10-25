// Creates or syncs the Tidy blueprint. Re-run after changing config/tidy.ts:
// node --env-file=.env.local scripts/setup-blueprint.ts
import { tidy } from "../config/tidy.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The fields of a WorkOS agent blueprint that this script reads.
type Blueprint = {
  id: string;
  name: string;
  permissions: string[];
  invocable_by: { role_slugs: string[]; organization_ids: string[] };
  invocable_as: { instance_types: string[] };
  session_settings: Record<string, unknown>;
};

// The reviewed Node SDK does not yet expose invocable_as, so use the REST API.
// https://workos.com/docs/reference/agents/blueprint#create-an-agent-blueprint
export async function setupBlueprint(): Promise<string> {
  const apiKey = process.env.WORKOS_API_KEY;
  const organizationId = process.env.WORKOS_ORGANIZATION_ID;
  if (!apiKey || !organizationId) throw new Error("Set WORKOS_API_KEY and WORKOS_ORGANIZATION_ID first.");
  const body = {
    name: tidy.name,
    permissions: [...tidy.ceiling],
    invocable_by: { role_slugs: [tidy.humanRoleSlug], organization_ids: [organizationId] },
    invocable_as: { instance_types: ["delegated"] },
    session_settings: {
      max_age_seconds: tidy.sessionTtlSeconds,
      access_token_ttl_seconds: tidy.accessTokenTtlSeconds,
      refresh_token_ttl_seconds: tidy.refreshTokenTtlSeconds,
    },
  };
  const call = async <T>(path: string, method = "GET", payload?: unknown): Promise<T> => {
    const response = await fetch(`https://api.workos.com/agents/blueprints${path}`, {
      method,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok)
      throw new Error(`Blueprint setup failed (HTTP ${response.status}). Check the WorkOS dashboard.`);
    return (await response.json()) as T;
  };
  let id = process.env.WORKOS_AGENT_BLUEPRINT_ID;
  if (!id) {
    const list = await call<{ data: Blueprint[] }>("?limit=100");
    id = list.data.find(blueprint => blueprint.name === tidy.name)?.id;
  }
  if (id) {
    const path = `/${encodeURIComponent(id)}`;
    const current = await call<Blueprint>(path);
    if (current.name !== tidy.name)
      throw new Error("Configured blueprint is not Tidy; refusing to overwrite it.");
    const sameList = (a: string[], b: string[]) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const matches =
      sameList(current.permissions, body.permissions) &&
      sameList(current.invocable_by.role_slugs, body.invocable_by.role_slugs) &&
      sameList(current.invocable_by.organization_ids, body.invocable_by.organization_ids) &&
      sameList(current.invocable_as.instance_types, body.invocable_as.instance_types) &&
      Object.entries(body.session_settings).every(([key, value]) => current.session_settings[key] === value);
    if (!matches) await call<Blueprint>(path, "PATCH", body);
    return id;
  }
  return (await call<Blueprint>("", "POST", body)).id;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupBlueprint()
    .then(id => console.log(`WORKOS_AGENT_BLUEPRINT_ID=${id}`))
    .catch(error => {
      console.error(error instanceof Error ? error.message : "Blueprint setup failed.");
      process.exitCode = 1;
    });
}
