import { demo } from "@/demo.config";
import type { AgentEvent } from "@/lib/agent-events";

export function agentMode(): Extract<AgentEvent, { type: "mode" }> {
  return demo.agentMode === "gemini" && process.env.GEMINI_API_KEY
    ? { type: "mode", mode: "gemini", label: demo.geminiModelLabel }
    : {
        type: "mode",
        mode: "scripted",
        label: "Scripted demo · no LLM",
        note: demo.agentMode === "gemini" ? "Gemini isn't connected" : "Scripted mode is selected",
      };
}
