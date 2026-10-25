import { demo } from "../demo.config.ts";

// Permission slugs and the agent ceiling come from demo.config.ts.
export const customerPermissions = demo.permissionSlugs;

export type CustomerPermission = (typeof customerPermissions)[number];

const ceiling: readonly CustomerPermission[] = demo.agentCeiling;

export const tidy = {
  // Blueprint name. scripts/setup-blueprint.ts finds and updates the blueprint by this name.
  name: "Tidy",
  ceiling,
  // Blueprint max_age_seconds: the hard ceiling on an agent session chain's lifetime.
  // This app also uses it as the sign-in freshness window before minting (step-up).
  sessionTtlSeconds: 1800,
  accessTokenTtlSeconds: 600,
  refreshTokenTtlSeconds: 1800,
  humanRoleSlug: "data-manager",
  seedCount: 1206,
};
