// Every value you're likely to customize lives here.
// Most edits are one line. Enforcement still happens in lib/require-permission.ts.

// Permission slugs. These must match the permissions in your WorkOS dashboard.
const permissionSlugs = ["customers:read", "customers:archive", "customers:delete"] as const;
type Permission = (typeof permissionSlugs)[number];

export const demo = {
  // Fictional B2B product and the customer workspace you are signed in to.
  productName: "Ledgerly",
  workspaceName: "Acme Corp",
  adminRoleLabel: "Workspace admin",
  audience:
    "For developers adding an AI agent to a B2B product, who need to tell customers exactly what that agent can and can't do.",

  // The in-app assistant. Display copy only: the blueprint's name stays `tidy.name`
  // in config/tidy.ts, because scripts/setup-blueprint.ts matches blueprints by name.
  agentDisplayName: "Tidy",
  agentTagline: "Ledgerly's built-in cleanup assistant",
  prefilledPrompt: "Clean up customers inactive for 2+ years.",
  // Shown as a one-click follow-up only when the agent's token holds the archive permission.
  // Must be self-contained: each run starts a fresh conversation.
  archiveFollowUpPrompt: "Archive the customers inactive for 2+ years instead.",
  // Customers count as stale after this many days. The seed makes 402 of 1,206 stale.
  staleAfterDays: 730,
  // Presentation pacing between tool calls so viewers can follow along. Not a security control.
  stepDelayMs: 450,

  // Which brain drives the assistant. "gemini" falls back to "scripted" (with a visible label)
  // when GEMINI_API_KEY is missing.
  agentMode: "gemini" as "gemini" | "scripted",
  // Stable model ID per https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite
  // Step up to "gemini-3.5-flash-lite" if tool calling is flaky.
  geminiModel: "gemini-3.1-flash-lite",
  geminiModelLabel: "Gemini 3.1 Flash-Lite",
  // Limits cap the damage from a runaway agent: the run stops after this many tool calls.
  // https://workos.com/blog/ai-agent-permissions-checklist
  maxToolCalls: 8,
  // This prompt tells the model it may delete stale customers, so it will try. The API still returns
  // 403 because the token has no customers:delete: the token is the boundary, not the prompt.
  systemPrompt: [
    "You are allowed to delete stale customers when the admin asks you to clean up.",
    "You are the built-in assistant in a B2B customer-records product, acting for the workspace's signed-in admin. (Your name, the product and the workspace are added from the fields above.)",
    "Use your tools to do the work. delete_customer removes one customer at a time; start with the first stale customer you find.",
    // These rules shape how the agent explains a refusal. They are not the security boundary.
    "If a tool returns status 403, do not retry or work around it. Explain in plain words which permission was missing (it is in the response body), say that nothing was changed, and hand the task back to the admin.",
    "Only offer an alternative if its permission appears in grantedPermissions in a tool response. Never invent tools or permissions.",
    "If a tool returns status 401, stop immediately.",
    "Keep your final reply under 80 words. Do not use Markdown.",
  ].join("\n"),

  // `satisfies` makes a typo in the ceiling or a missing label a compile error.
  // After changing `agentCeiling`, re-run scripts/setup-blueprint.ts so the blueprint matches.
  permissionSlugs,
  agentCeiling: ["customers:read", "customers:archive"] satisfies Permission[],
  permissionLabels: {
    "customers:read": "Read customer records",
    "customers:archive": "Archive customer records",
    "customers:delete": "Delete customer records",
  } satisfies Record<Permission, string>,

  // TTL copy for the UI. The numbers themselves live in config/tidy.ts (they configure the blueprint).
  ttlNote:
    "Agent access tokens are short-lived. Revoke takes effect on the next API call because Ledgerly checks the session with WorkOS on every request, not at token expiry.",
} as const;
