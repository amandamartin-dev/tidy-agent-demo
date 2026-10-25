import { demo } from "@/demo.config";

// What both runners stream to the side panel, one event per line of the /api/agent/run response.
export type AgentEvent =
  | { type: "mode"; mode: "gemini" | "scripted"; label: string; note?: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; args: string }
  | {
      type: "tool_result";
      id: string;
      status: number;
      tone: "ok" | "denied" | "error";
      summary: string;
      body?: string;
    }
  | { type: "assistant"; text: string }
  | { type: "done"; outcome: "denied" | "deleted" | "archived" | "nothing" | "revoked" | "limit" | "error" };

// The run route stamps each event with a unique id as it is created, so the panel keys
// transcript rows by data, not position. https://react.dev/learn/rendering-lists#where-to-get-your-key
export type StreamedEvent = AgentEvent & { eventId: string };

export const revokedReply = () =>
  `My session in the ${demo.workspaceName} workspace is no longer live (revoked or expired), so I've stopped. ${demo.productName} checks my session with WorkOS on every call, so a revoke stops me on my next request even while my token is still signed.`;
