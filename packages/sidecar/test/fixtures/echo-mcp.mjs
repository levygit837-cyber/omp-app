// Minimal stdio MCP server with one tool, `echo_<label>`. argv[2] is the label.
import * as readline from "node:readline";

const label = process.argv[2] ?? "a";
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case "initialize":
      return send({
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: `echo-${label}`, version: "0.0.0" },
        },
      });
    case "tools/list":
      return send({
        id: msg.id,
        result: {
          tools: [
            {
              name: `echo_${label}`,
              description: `Echoes the text, prefixed with ${label}:`,
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        },
      });
    case "tools/call":
      return send({
        id: msg.id,
        result: {
          content: [{ type: "text", text: `${label}: ${msg.params?.arguments?.text ?? ""}` }],
        },
      });
    default:
      return send({ id: msg.id, error: { code: -32601, message: "unknown method" } });
  }
});
