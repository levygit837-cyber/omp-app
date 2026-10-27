// A second omp process: creates a session, writes one turn (which claims it) and holds the claim
// until it is killed. Stands in for a CLI that has the session open.
// Usage: bun hold-session.ts <agent dir> <cwd>
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir } from "@oh-my-pi/pi-utils";

const [agentDir, cwd] = process.argv.slice(2) as [string, string];
setAgentDir(agentDir);
const manager = SessionManager.create(cwd);
await manager.ensureOnDisk();
manager.appendMessage({ role: "user", content: "held by the other process", timestamp: 1 });
manager.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "yes" }],
  api: "openai-completions",
  provider: "openai",
  model: "gpt-4o-mini",
  usage: {
    input: 0,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 2,
});
await manager.flush();
console.log(JSON.stringify({ id: manager.getSessionId(), file: manager.getSessionFile() }));
await new Promise(() => {});
