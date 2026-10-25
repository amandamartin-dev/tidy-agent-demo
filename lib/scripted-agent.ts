import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { demo } from "@/demo.config";
import type { ChangeBody, CustomerListBody } from "@/lib/api-body";
import { revokedReply, type AgentEvent } from "@/lib/agent-events";
import { agentCall, type ApiResult, type Credential } from "@/lib/agent-http";

// Scripted runner, used when Gemini isn't configured. Not an LLM: it picks a plan by keyword, then
// makes the same API calls with the agent token.
const list = (items: readonly string[]) =>
  items.length > 1
    ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
    : (items[0] ?? "nothing");

export async function runScriptedAgent(
  origin: string,
  credential: Credential,
  prompt: string,
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal,
) {
  const [, archiveSlug, deleteSlug] = demo.permissionSlugs;
  const plan: "archive" | "cleanup" = /archiv/i.test(prompt) ? "archive" : "cleanup";
  let callNumber = 0;

  async function tool<T>(name: string, args: string, path: string, data?: unknown) {
    await delay(demo.stepDelayMs, undefined, { signal });
    signal?.throwIfAborted();
    const id = `call_${++callNumber}`;
    emit({ type: "tool_call", id, name, args });
    let result: ApiResult<T>;
    try {
      result = await agentCall<T>(origin, credential.accessToken, path, data, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      result = {
        ok: false,
        status: 503,
        raw: '{"error":"The request failed before Ledgerly answered."}',
        data: { error: "The request failed before Ledgerly answered." },
      };
    }
    return { id, ...result };
  }

  // A 401 means the session behind the token is no longer live (revoked or expired).
  function stoppedByRevoke(call: { id: string; status: number; raw: string }) {
    if (call.status !== 401) return false;
    emit({
      type: "tool_result",
      id: call.id,
      status: 401,
      tone: "error",
      summary: "401 · agent session is not live",
      body: call.raw,
    });
    emit({ type: "assistant", text: revokedReply() });
    emit({ type: "done", outcome: "revoked" });
    return true;
  }

  function failed(call: { id: string; status: number; raw: string }) {
    emit({
      type: "tool_result",
      id: call.id,
      status: call.status,
      tone: "error",
      summary: `${call.status} · request failed`,
      body: call.raw,
    });
    emit({
      type: "assistant",
      text: "I could not confirm that call, so I stopped. Review the records before retrying.",
    });
    emit({ type: "done", outcome: "error" });
  }

  emit({
    type: "thinking",
    text:
      plan === "cleanup"
        ? `Looking for ${demo.workspaceName} customers inactive for ${demo.staleAfterDays / 365}+ years.`
        : `Finding the stale customers so I can archive them.`,
  });

  const listed = await tool<CustomerListBody>(
    "list_customers",
    `inactive_days: ${demo.staleAfterDays}`,
    `/api/customers?inactiveDays=${demo.staleAfterDays}`,
  );
  if (stoppedByRevoke(listed)) return;
  if (!listed.ok) return failed(listed);
  const ids = listed.data.customers.filter(row => row.status === "active").map(row => row.id);
  emit({
    type: "tool_result",
    id: listed.id,
    status: 200,
    tone: "ok",
    summary: `200 · found ${ids.length} stale customers`,
  });
  if (!ids.length) {
    emit({
      type: "assistant",
      text: "There are no stale active customers left, so there's nothing for me to do. Reset the sample data to try again.",
    });
    emit({ type: "done", outcome: "nothing" });
    return;
  }

  if (plan === "cleanup") {
    // Try one record first. A careful agent stops at the first refusal instead of retrying 402 times.
    const target = ids[0];
    const del = await tool<ChangeBody>("delete_customer", target, "/api/customers/delete", { ids: [target] });
    if (stoppedByRevoke(del)) return;
    if (del.ok) {
      emit({ type: "tool_result", id: del.id, status: 200, tone: "ok", summary: `200 · deleted ${target}` });
      emit({
        type: "assistant",
        text: `I deleted ${target}. My token includes ${list([deleteSlug])}, so ${demo.productName} allowed it. I stopped after one record so you can review before I go further.`,
      });
      emit({ type: "done", outcome: "deleted" });
      return;
    }
    if (del.status !== 403) return failed(del);
    const missing = del.data.missingPermission ?? deleteSlug;
    const granted = del.data.grantedPermissions ?? credential.permissions;
    emit({
      type: "tool_result",
      id: del.id,
      status: 403,
      tone: "denied",
      summary: `403 · missing ${missing}`,
      body: del.raw,
    });
    const canArchive = granted.includes(archiveSlug);
    emit({
      type: "assistant",
      text: [
        `I can't delete customers in ${demo.workspaceName}. My token only grants ${list(granted)}. ${demo.productName} refused the delete because ${missing} isn't one of them.`,
        `I stopped at the first refusal, so all ${ids.length} records are unchanged.`,
        `Over to you: you can review and delete them yourself from the records table if your role allows it.${canArchive ? ` Or ask me to archive them instead; I do have ${list([archiveSlug])}.` : ""}`,
      ].join(" "),
    });
    emit({ type: "done", outcome: "denied" });
    return;
  }

  const archived = await tool<ChangeBody>(
    "archive_customers",
    `${ids.length} ids`,
    "/api/customers/archive",
    {
      ids,
    },
  );
  if (stoppedByRevoke(archived)) return;
  if (!archived.ok && archived.status === 403) {
    emit({
      type: "tool_result",
      id: archived.id,
      status: 403,
      tone: "denied",
      summary: `403 · missing ${archived.data.missingPermission ?? archiveSlug}`,
      body: archived.raw,
    });
    emit({
      type: "assistant",
      text: `I can't archive customers either: my token doesn't include ${list([archiveSlug])}. Nothing changed. This one is yours.`,
    });
    emit({ type: "done", outcome: "denied" });
    return;
  }
  if (!archived.ok) return failed(archived);
  emit({
    type: "tool_result",
    id: archived.id,
    status: 200,
    tone: "ok",
    summary: `200 · archived ${archived.data.count}`,
  });
  emit({
    type: "assistant",
    text: `Archived ${archived.data.count} stale customers. Each row is recorded as "${archived.data.changedBy}", so you can see the agent did it and who it acted for. Nothing was deleted, so the records stay recoverable.`,
  });
  emit({ type: "done", outcome: "archived" });
}
