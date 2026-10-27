import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * An OpenAI-compatible endpoint that echoes the last user message back, streamed in two chunks,
 * so a test can run a real omp turn without the network. `beforeAnswer` runs once the request
 * arrived and before anything is streamed (a test can hold the turn inside the model call).
 */
export function startEchoModel(beforeAnswer?: () => Promise<void> | void) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { role: string; content: unknown }[];
      };
      const last = body.messages.filter((m) => m.role === "user").at(-1);
      // omp sends the content as parts, with a system reminder before the prompt.
      const parts = Array.isArray(last?.content)
        ? (last.content as { type: string; text?: string }[])
        : [{ type: "text", text: String(last?.content) }];
      const text = parts.filter((part) => part.type === "text").at(-1)?.text ?? "";
      await beforeAnswer?.();
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          created: 1,
          model: "echo",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      const half = Math.ceil(text.length / 2);
      const stream = [
        chunk({ role: "assistant", content: "" }),
        chunk({ content: `echo ${text.slice(0, half)}` }),
        chunk({ content: text.slice(half) }),
        chunk({}, "stop"),
        "data: [DONE]\n\n",
      ].join("");
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

/** Registers the server as the `local-echo` provider of a throwaway agent dir. */
export function registerEchoModel(agentDir: string, port: number | undefined): void {
  writeFileSync(
    join(agentDir, "models.yml"),
    [
      "providers:",
      "  local-echo:",
      `    baseUrl: http://127.0.0.1:${port}/v1`,
      "    apiKey: sk-test-not-a-real-key",
      "    api: openai-completions",
      "    models:",
      "      - id: echo",
      "        name: Echo",
      "",
    ].join("\n"),
  );
}

/**
 * Selects the echo model for this session. Settings are a process-wide singleton that another
 * test file may have loaded first, so the config default cannot be relied on.
 */
export async function useEchoModel(session: AgentSession): Promise<void> {
  const echo = session.modelRegistry.find("local-echo", "echo");
  if (!echo) throw new Error("the local model is not in the registry");
  await session.setModel(echo, "default", { persist: false });
}
