// Sets up a fresh WorkOS environment for this app with the API key alone, then writes the
// resulting IDs into the env file. Safe to re-run: each step looks for what exists first.
//   pnpm setup:workos --email you@example.com [--env .env.local]
// Dashboard-only (no API): Google as the only sign-in method, the sign-out redirect and the
// initiate login URI.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { tidy } from "../config/tidy.ts";
import { demo } from "../demo.config.ts";
import { setupBlueprint } from "./setup-blueprint.ts";

const { values } = parseArgs({ options: { email: { type: "string" }, env: { type: "string" } } });
const envFile = values.env ?? ".env.local";
if (!existsSync(envFile))
  throw new Error(`${envFile} not found. Copy .env.example and add your API key and client ID.`);
process.loadEnvFile(envFile);
const apiKey = process.env.WORKOS_API_KEY;
const clientId = process.env.WORKOS_CLIENT_ID;
if (!apiKey || !clientId) throw new Error(`Set WORKOS_API_KEY and WORKOS_CLIENT_ID in ${envFile} first.`);
const callbackUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI || "http://localhost:3000/callback";

// https://workos.com/docs/reference
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`https://api.workos.com${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const detail = ((await response.json().catch(() => ({}))) as { message?: string }).message ?? "";
    throw new Error(`${method} ${path} failed (HTTP ${response.status}) ${detail}`.trim());
  }
  return (await response.json()) as T;
}
async function listAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let after: string | null = null;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const page: { data: T[]; list_metadata?: { after: string | null } } = await api(
      `${path}${separator}limit=100${after ? `&after=${after}` : ""}`,
    );
    items.push(...page.data);
    after = page.list_metadata?.after ?? null;
  } while (after);
  return items;
}
function writeEnv(updates: Record<string, string>) {
  let text = readFileSync(envFile, "utf8");
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    text = pattern.test(text)
      ? text.replace(pattern, () => `${key}=${value}`)
      : `${text.replace(/\n?$/, "\n")}${key}=${value}\n`;
  }
  writeFileSync(envFile, text);
}
const done = (message: string) => console.log(`✓ ${message}`);

// Fail fast, before creating anything, if the environment can't use Agent Auth.
await api("/agents/blueprints?limit=1").catch((error: unknown) => {
  throw new Error(
    `Agent Auth is not available in this environment. Contact your WorkOS account team. (${String(error)})`,
  );
});

// https://workos.com/docs/reference/roles/permission
const permissions = new Set((await listAll<{ slug: string }>("/authorization/permissions")).map(p => p.slug));
for (const slug of demo.permissionSlugs)
  if (!permissions.has(slug))
    await api("/authorization/permissions", "POST", { slug, name: demo.permissionLabels[slug] });
done(`Permissions: ${demo.permissionSlugs.join(", ")}`);

// https://workos.com/docs/reference/roles/role
const roles = await api<{ data: { slug: string }[] }>("/authorization/roles");
if (!roles.data.some(role => role.slug === tidy.humanRoleSlug))
  await api("/authorization/roles", "POST", { slug: tidy.humanRoleSlug, name: "Data manager" });
await api(`/authorization/roles/${tidy.humanRoleSlug}/permissions`, "PUT", {
  permissions: [...demo.permissionSlugs],
});
done(`Role ${tidy.humanRoleSlug} with all three permissions`);

// https://workos.com/docs/reference/organization
// Re-runs keep the organization already in the env file, whatever it's named (WorkOS's built-in
// staging "Test Organization" can't be renamed). A fresh setup finds or creates one named after
// demo.workspaceName, which is display copy only: the app itself uses the ID.
const organizations = await listAll<{ id: string; name: string }>("/organizations");
const existing =
  organizations.find(org => org.id === process.env.WORKOS_ORGANIZATION_ID) ??
  organizations.find(org => org.name === demo.workspaceName);
const organizationId =
  existing?.id ?? (await api<{ id: string }>("/organizations", "POST", { name: demo.workspaceName })).id;
done(`Organization ${existing?.name ?? demo.workspaceName} (${organizationId})`);

// https://workos.com/docs/reference/authkit/redirect-uri
const redirects = await listAll<{ uri: string }>("/user_management/redirect_uris");
if (!redirects.some(redirect => redirect.uri === callbackUri))
  await api("/user_management/redirect_uris", "POST", { uri: callbackUri });
done(`Redirect URI ${callbackUri}`);

// Put the developer in the organization with the role: an existing pending invitation, a
// membership if they have signed in before, otherwise a new invitation. An invitation creates a
// pending membership that only accepting it can activate.
// https://workos.com/docs/reference/authkit/invitation
if (values.email) {
  const email = values.email;
  const query = `email=${encodeURIComponent(email)}`;
  type Invitation = { state: string; accept_invitation_url: string };
  // Printed as well as emailed, since the email can land in spam.
  const invited = (invitation: Invitation) =>
    done(
      `Invitation for ${email}. Open this link to accept it, then sign in:\n  ${invitation.accept_invitation_url}`,
    );
  const invitations = await api<{ data: Invitation[] }>(
    `/user_management/invitations?${query}&organization_id=${organizationId}`,
  );
  const [user] = (await api<{ data: { id: string }[] }>(`/user_management/users?${query}`)).data;
  const pending = invitations.data.find(invitation => invitation.state === "pending");
  if (pending) {
    invited(pending);
  } else if (user) {
    const memberships = await api<{ data: { role?: { slug: string } }[] }>(
      `/user_management/organization_memberships?user_id=${user.id}&organization_id=${organizationId}`,
    );
    if (!memberships.data.length)
      await api("/user_management/organization_memberships", "POST", {
        user_id: user.id,
        organization_id: organizationId,
        role_slug: tidy.humanRoleSlug,
      });
    else if (memberships.data[0].role?.slug !== tidy.humanRoleSlug)
      console.warn(
        `! ${email} is in the organization without the ${tidy.humanRoleSlug} role. Change it in the dashboard.`,
      );
    done(`${email} is a member with ${tidy.humanRoleSlug}`);
  } else {
    invited(
      await api<Invitation>("/user_management/invitations", "POST", {
        email,
        organization_id: organizationId,
        role_slug: tidy.humanRoleSlug,
      }),
    );
  }
} else
  console.warn(
    "! No --email given: add yourself to the organization with the data-manager role in the dashboard.",
  );

// Agent tokens are issued by the AuthKit domain; its discovery document states the issuer.
// https://workos.com/docs/authkit/agent-blueprints#agent-token-claims
const authorize = new URL("https://api.workos.com/user_management/authorize");
authorize.search = new URLSearchParams({
  provider: "authkit",
  response_type: "code",
  client_id: clientId,
  redirect_uri: callbackUri,
}).toString();
const hosted = (await fetch(authorize, { redirect: "manual" })).headers.get("location");
if (!hosted) throw new Error("Could not find the AuthKit domain. Set WORKOS_AGENT_ISSUER by hand.");
const discovery = await fetch(new URL("/.well-known/openid-configuration", hosted));
const { issuer } = (await discovery.json()) as { issuer: string };
done(`Agent token issuer ${issuer}`);

writeEnv({
  WORKOS_ORGANIZATION_ID: organizationId,
  WORKOS_AGENT_ISSUER: issuer,
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: callbackUri,
  ...(process.env.WORKOS_COOKIE_PASSWORD
    ? {}
    : { WORKOS_COOKIE_PASSWORD: randomBytes(24).toString("base64") }),
});
process.env.WORKOS_ORGANIZATION_ID = organizationId;
const blueprintId = await setupBlueprint();
writeEnv({ WORKOS_AGENT_BLUEPRINT_ID: blueprintId });
done(`Blueprint ${tidy.name} (${blueprintId})`);
console.log(`\nWrote the IDs to ${envFile}. Then, in the WorkOS dashboard:`);
console.log("  - Authentication: make Google OAuth the only sign-in method");
console.log("  - Redirects: sign-out http://localhost:3000, initiate login http://localhost:3000/login");
console.log("Then run: pnpm dev");
