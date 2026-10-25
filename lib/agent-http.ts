import "server-only";
import { errorBody, type ErrorBody } from "@/lib/api-body";

// How both agent runners reach Ledgerly's customer API: plain HTTP with the agent's Bearer token.
export type Credential = {
  accessToken: string;
  sessionId: string;
  agentInstanceId: string;
  permissions: string[];
};
export type ApiResult<T> =
  | { ok: true; status: number; raw: string; data: T }
  | { ok: false; status: number; raw: string; data: ErrorBody };

export async function agentCall<T>(
  origin: string,
  token: string,
  path: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  const response = await fetch(`${origin}${path}`, {
    method: data === undefined ? "GET" : "POST",
    redirect: "error",
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const raw = await response.text();
  const body: unknown = JSON.parse(raw);
  // Success bodies come from this app's own API and are typed by the caller at this one boundary.
  return response.ok
    ? { ok: true, status: response.status, raw, data: body as T }
    : { ok: false, status: response.status, raw, data: errorBody(body) };
}
