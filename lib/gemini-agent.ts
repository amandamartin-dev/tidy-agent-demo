import "server-only";
import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { demo } from "@/demo.config";
import type { ChangeBody, CustomerListBody } from "@/lib/api-body";
import { revokedReply, type AgentEvent } from "@/lib/agent-events";
import { agentCall, type ApiResult, type Credential } from "@/lib/agent-http";

// Gemini chooses the tool calls; each tool runs here on the server and calls Ledgerly's API with
// the agent token. The model sees the prompts and each tool's status and JSON body, never a
// credential. Stateless generateContent with manual function calling: history is resent each turn.
// https://ai.google.dev/gemini-api/docs/function-calling

const tools: FunctionDeclaration[] = [
  {
    name: "list_customers",
    description:
      "List customers in the workspace that have been inactive for at least `inactive_days` days. Returns how many are still active and the first few customer IDs.",
    parametersJsonSchema: {
      type: "object",
      properties: { inactive_days: { type: "integer", minimum: 0, maximum: 36500 } },
      required: ["inactive_days"],
    },
  },
  {
    name: "delete_customer",
    description: "Permanently delete one customer record by ID (format customer_0000).",
    parametersJsonSchema: {
      type: "object",
      properties: { customer_id: { type: "string", pattern: "^customer_\\d{4}$" } },
      required: ["customer_id"],
    },
  },
  {
    name: "archive_customers",
    description:
      "Archive every active customer inactive for at least `inactive_days` days. Archived records are kept and can be restored.",
    parametersJsonSchema: {
      type: "object",
      properties: { inactive_days: { type: "integer", minimum: 0, maximum: 36500 } },
      required: ["inactive_days"],
    },
  },
];

type ToolResult = { status: number; body: Record<string, unknown> };
type Outcome = Extract<AgentEvent, { type: "done" }>["outcome"];

function days(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 36500 ? value : null;
}

export async function runGeminiAgent(
  origin: string,
  credential: Credential,
  prompt: string,
  emit: (event: AgentEvent) => void,
  apiKey: string,
  signal?: AbortSignal,
) {
  const [, archiveSlug, deleteSlug] = demo.permissionSlugs;
  let outcome: Outcome = "nothing";
  const effects = { mutations: 0 };
  let callNumber = 0;

  // Tool executors call the API with the agent's Bearer token and return one compact result.
  async function http<T>(path: string, data?: unknown): Promise<ApiResult<T>> {
    try {
      signal?.throwIfAborted();
      return await agentCall<T>(origin, credential.accessToken, path, data, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        ok: false,
        status: 503,
        raw: "",
        data: { error: "The result could not be confirmed. Review the records before retrying." },
      };
    }
  }
  async function listStale(inactiveDays: number) {
    const listed = await http<CustomerListBody>(`/api/customers?inactiveDays=${inactiveDays}`);
    const ids = listed.ok
      ? listed.data.customers.filter(row => row.status === "active").map(row => row.id)
      : [];
    return { listed, ids };
  }
  async function execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: ToolResult; summary: string; tone: "ok" | "denied" | "error"; raw?: string }> {
    if (name === "list_customers") {
      const inactiveDays = days(args.inactive_days);
      if (inactiveDays === null)
        return {
          result: { status: 400, body: { error: "inactive_days must be an integer from 0 to 36500." } },
          summary: "400 · bad arguments",
          tone: "error",
        };
      const { listed, ids } = await listStale(inactiveDays);
      if (!listed.ok)
        return {
          result: { status: listed.status, body: listed.data },
          summary: `${listed.status} · ${listed.data.error ?? "request failed"}`,
          tone: listed.status === 403 ? "denied" : "error",
          raw: listed.raw,
        };
      // Trimmed on purpose: 402 rows would cost tokens and add nothing the model needs.
      return {
        result: {
          status: 200,
          body: {
            active_count: ids.length,
            first_ids: ids.slice(0, 10),
            omitted: Math.max(0, ids.length - 10),
          },
        },
        summary: `200 · found ${ids.length} stale customers`,
        tone: "ok",
      };
    }
    if (name === "delete_customer") {
      const id =
        typeof args.customer_id === "string" && /^customer_\d{4}$/.test(args.customer_id)
          ? args.customer_id
          : null;
      if (!id)
        return {
          result: { status: 400, body: { error: "customer_id must look like customer_0001." } },
          summary: "400 · bad arguments",
          tone: "error",
        };
      const deleted = await http<ChangeBody>("/api/customers/delete", { ids: [id] });
      if (deleted.ok) {
        outcome = "deleted";
        effects.mutations++;
        return {
          result: { status: 200, body: { deleted: id, changedBy: deleted.data.changedBy } },
          summary: `200 · deleted ${id}`,
          tone: "ok",
        };
      }
      return {
        result: { status: deleted.status, body: deleted.data },
        summary:
          deleted.status === 403
            ? `403 · missing ${deleted.data.missingPermission ?? deleteSlug}`
            : `${deleted.status} · ${deleted.data.error ?? "request failed"}`,
        tone: deleted.status === 403 ? "denied" : "error",
        raw: deleted.raw,
      };
    }
    if (name === "archive_customers") {
      const inactiveDays = days(args.inactive_days);
      if (inactiveDays === null)
        return {
          result: { status: 400, body: { error: "inactive_days must be an integer from 0 to 36500." } },
          summary: "400 · bad arguments",
          tone: "error",
        };
      const { listed, ids } = await listStale(inactiveDays);
      if (!listed.ok)
        return {
          result: { status: listed.status, body: listed.data },
          summary: `${listed.status} · ${listed.data.error ?? "request failed"}`,
          tone: "error",
          raw: listed.raw,
        };
      if (!ids.length)
        return {
          result: { status: 200, body: { archived: 0 } },
          summary: "200 · nothing to archive",
          tone: "ok",
        };
      const archived = await http<ChangeBody>("/api/customers/archive", { ids });
      if (archived.ok) {
        outcome = "archived";
        effects.mutations++;
        return {
          result: {
            status: 200,
            body: { archived: archived.data.count, changedBy: archived.data.changedBy },
          },
          summary: `200 · archived ${archived.data.count}`,
          tone: "ok",
        };
      }
      return {
        result: { status: archived.status, body: archived.data },
        summary:
          archived.status === 403
            ? `403 · missing ${archived.data.missingPermission ?? archiveSlug}`
            : `${archived.status} · ${archived.data.error ?? "request failed"}`,
        tone: archived.status === 403 ? "denied" : "error",
        raw: archived.raw,
      };
    }
    return {
      result: { status: 404, body: { error: `No tool named ${name}.` } },
      summary: "404 · unknown tool",
      tone: "error",
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const systemInstruction = [
    `Your name is ${demo.agentDisplayName}. The product is ${demo.productName}. The workspace is ${demo.workspaceName}.`,
    `A customer is stale when inactive for at least ${demo.staleAfterDays} days. Use inactive_days: ${demo.staleAfterDays} unless the admin names a different period.`,
    demo.systemPrompt,
  ].join("\n");
  const contents: Content[] = [{ role: "user", parts: [{ text: prompt }] }];
  let toolCalls = 0;

  // A model turn per loop; the tool-call cap below is the real bound.
  for (let turn = 0; turn <= demo.maxToolCalls; turn++) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await ai.models.generateContent({
        model: demo.geminiModel,
        contents,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: tools }],
          maxOutputTokens: 1024,
          abortSignal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // Fail closed: no model, no actions. Error details are not shown; they can echo request data.
      emit({
        type: "assistant",
        text: "I couldn't reach the model, so I stopped. Nothing else was changed.",
      });
      emit({ type: "done", outcome: "error" });
      return;
    }
    const modelContent = response.candidates?.[0]?.content;
    const parts: Part[] = modelContent?.parts ?? [];
    const text = parts
      .filter(part => typeof part.text === "string" && !part.thought)
      .map(part => part.text)
      .join("")
      .trim();
    const calls = response.functionCalls ?? [];

    if (!calls.length) {
      const finished = !!text;
      emit({
        type: "assistant",
        text:
          text || "The model returned no final reply. Review the tool results and records before retrying.",
      });
      emit({ type: "done", outcome: finished ? outcome : "error" });
      return;
    }
    if (text) emit({ type: "thinking", text });
    // Resend the model's turn unchanged so any thought signatures on its parts survive.
    contents.push(modelContent ?? { role: "model", parts: calls.map(call => ({ functionCall: call })) });

    const responses: Part[] = [];
    for (const call of calls) {
      if (toolCalls >= demo.maxToolCalls) {
        emit({
          type: "assistant",
          text: `I reached my limit of ${demo.maxToolCalls} tool calls for one request, so I stopped. Please review the records before asking again.`,
        });
        emit({ type: "done", outcome: "limit" });
        return;
      }
      signal?.throwIfAborted();
      toolCalls++;
      const name = call.name ?? "unknown";
      const args = call.args ?? {};
      const id = `call_${++callNumber}`;
      emit({
        type: "tool_call",
        id,
        name,
        args: Object.entries(args)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join(", "),
      });
      const { result, summary, tone, raw } = await execute(name, args);
      if (result.status === 401) {
        // Stop immediately, without asking the model: a revoked agent gets no further turns.
        emit({
          type: "tool_result",
          id,
          status: 401,
          tone: "error",
          summary: "401 · agent session is not live",
          body: raw,
        });
        emit({ type: "assistant", text: revokedReply() });
        emit({ type: "done", outcome: "revoked" });
        return;
      }
      emit({ type: "tool_result", id, status: result.status, tone, summary, ...(raw ? { body: raw } : {}) });
      if (result.status >= 400) {
        // Stop the whole run, including queued calls from this turn. An alternative needs a new request.
        const changed = effects.mutations > 0;
        const missing =
          typeof result.body.missingPermission === "string"
            ? result.body.missingPermission
            : "the required permission";
        const granted = Array.isArray(result.body.grantedPermissions) ? result.body.grantedPermissions : [];
        const alternative =
          result.status === 403 && granted.includes(archiveSlug) ? " You can ask me to archive instead." : "";
        emit({
          type: "assistant",
          text:
            result.status === 403
              ? `Ledgerly refused this action because my token lacks ${missing}. I stopped at that refusal. ${changed ? "Earlier successful changes remain." : "No changes were confirmed in this request."} Over to you.${alternative}`
              : "This tool failed, so I stopped. Its result may be uncertain; review the records before retrying.",
        });
        emit({ type: "done", outcome: result.status === 403 ? "denied" : "error" });
        return;
      }
      responses.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name,
          response: { status: result.status, body: result.body },
        },
      });
    }
    contents.push({ role: "user", parts: responses });
  }
  emit({
    type: "assistant",
    text: "I stopped because this request took too many steps. Nothing else was changed.",
  });
  emit({ type: "done", outcome: "limit" });
}
