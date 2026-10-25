import type { changeCustomers, listCustomers } from "@/lib/store";

// Response bodies of Ledgerly's customer API, derived from the store functions that produce them,
// so the agent runners and the UI stay in step with the server without a second schema.
export type CustomerListBody = ReturnType<typeof listCustomers>;
export type ChangeBody = NonNullable<ReturnType<typeof changeCustomers>>;

// Error bodies come from authErrorResponse. Their extra fields vary by error, so they are read
// field by field rather than trusted as a whole.
export type ErrorBody = { error?: string; missingPermission?: string; grantedPermissions?: string[] };

export function errorBody(value: unknown): ErrorBody {
  if (typeof value !== "object" || value === null) return {};
  const body: ErrorBody = {};
  if ("error" in value && typeof value.error === "string") body.error = value.error;
  if ("missingPermission" in value && typeof value.missingPermission === "string")
    body.missingPermission = value.missingPermission;
  if ("grantedPermissions" in value && Array.isArray(value.grantedPermissions))
    body.grantedPermissions = value.grantedPermissions.filter(
      (item): item is string => typeof item === "string",
    );
  return body;
}

export function errorMessage(value: unknown, fallback: string): string {
  return errorBody(value).error ?? fallback;
}
