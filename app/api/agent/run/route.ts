import { randomUUID } from "node:crypto";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { requirePermission } from "@/lib/require-permission";
import { requiredEnv } from "@/lib/workos";
import { authErrorResponse, AuthError } from "@/lib/auth-error";
import { appOrigin, body, mutationOrigin } from "@/lib/api";
import { ownedSession } from "@/lib/demo-sessions";
import type { AgentEvent, StreamedEvent } from "@/lib/agent-events";
import { runScriptedAgent } from "@/lib/scripted-agent";
import { runGeminiAgent } from "@/lib/gemini-agent";
import { agentMode } from "@/lib/agent-mode";

// Streams the assistant's tool calls to the side panel as newline-delimited JSON.
// The browser holds only an opaque demo handle; the agent token stays on the server.
// The runner calls Ledgerly's own API with that token, so each result is a real
// server decision. The human cookie here only proves who may watch this session.
export async function POST(request: Request) {
  try {
    mutationOrigin(request);
    if (request.headers.has("authorization"))
      throw new AuthError(401, "Use the hosted human session to run the assistant.");
    await requirePermission("customers:read", request);
    const auth = await withAuth();
    if (!auth.user) throw new AuthError(401, "Sign in first.");
    const { handle, prompt } = await body(request);
    if (typeof handle !== "string" || !/^[a-f0-9]{48}$/.test(handle))
      throw new AuthError(400, "Invalid demo handle.");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 500)
      throw new AuthError(400, "Send a prompt of 1–500 characters.");
    const session = ownedSession(handle, auth.user.id);
    if (session.busy || session.revoking) throw new AuthError(400, "The assistant is already working.");
    session.busy = true;
    session.runPrompt = prompt.trim();
    session.events = [];
    const controller = new AbortController();
    session.controller = controller;
    const signal = AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(120_000)]);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: AgentEvent) => {
          const streamed: StreamedEvent = { ...event, eventId: randomUUID() };
          session.events.push(streamed);
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(streamed)}\n`));
          } catch {
            session.controller?.abort(new Error("Viewer disconnected"));
          }
        };
        // Not awaited, so each event flushes to the browser as soon as it is enqueued.
        void (async () => {
          try {
            const mode = agentMode();
            emit(mode);
            if (mode.mode === "gemini") {
              await runGeminiAgent(
                appOrigin(),
                session.parent,
                prompt.trim(),
                emit,
                requiredEnv("GEMINI_API_KEY"),
                signal,
              );
            } else {
              await runScriptedAgent(appOrigin(), session.parent, prompt.trim(), emit, signal);
            }
          } catch {
            emit({
              type: "assistant",
              text: session.revoked
                ? "The admin revoked my session, so I stopped. Later API calls will be denied. Review the records for any call already in progress."
                : "The run was interrupted or timed out. Earlier changes may have completed; review the records before retrying.",
            });
            emit({ type: "done", outcome: session.revoked ? "revoked" : "error" });
          } finally {
            session.busy = false;
            delete session.controller;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        })();
      },
      cancel() {
        session.controller?.abort(new Error("Viewer disconnected"));
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
