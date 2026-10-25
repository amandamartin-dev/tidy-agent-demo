import "server-only";
import { AuthError } from "@/lib/auth-error";
import { requiredEnv } from "@/lib/workos";
import { tidy } from "@/config/tidy";
export function appOrigin() {
  return new URL(requiredEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI")).origin;
}
export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
// Cookie-authenticated mutations must originate in this application. Explicit
// Bearer credentials still use requirePermission and never fall back to cookies.
export function mutationOrigin(request: Request) {
  if (!request.headers.has("authorization") && request.headers.get("origin") !== appOrigin())
    throw new AuthError(403, "A same-origin request is required.");
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    // Limit bytes, not string length (UTF-16 units). Reject an oversized declared length before reading.
    if (Number(request.headers.get("content-length")) > 64_000) throw new Error();
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 64_000) throw new Error();
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AuthError(400, "Send a JSON object of at most 64 KB.");
  }
  if (!isPlainObject(parsed)) throw new AuthError(400, "Send a JSON object.");
  return parsed;
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCustomerIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id: unknown) => typeof id === "string" && /^customer_\d{4}$/.test(id))
  );
}
export function customerIds(data: Record<string, unknown>): string[] {
  const { ids } = data;
  if (
    !isCustomerIdList(ids) ||
    !ids.length ||
    ids.length > tidy.seedCount ||
    new Set(ids).size !== ids.length
  )
    throw new AuthError(400, `Supply 1–${tidy.seedCount} unique customer IDs.`);
  return ids;
}
