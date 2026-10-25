import type { StreamedEvent } from "@/lib/agent-events";

export async function readAgentEvents(
  stream: ReadableStream<Uint8Array>,
  receive: (event: StreamedEvent) => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as StreamedEvent;
    if (event.type === "done") completed = true;
    receive(event);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    buffer += decoder.decode();
    consume(buffer);
    if (!completed)
      throw new Error("The run was interrupted before completion. Review the records before retrying.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
