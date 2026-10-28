import {
  MCP_LIMITS,
  type McpSecretRef,
  type McpServerInput,
  type McpTransport,
} from "@omp-app/protocol";

/**
 * The renderer is untrusted: everything it sends to the MCP and skills requests is checked here
 * before it reaches the sidecar, and rebuilt field by field so nothing unknown passes through.
 * The sidecar checks again; this is the first door, not the only one.
 */

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > max) throw new Error(`${label} is longer than ${max} characters`);
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, label, max);
}

function secretMap(value: unknown, label: string): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > MCP_LIMITS.entries) {
    throw new Error(`${label} holds more than ${MCP_LIMITS.entries} entries`);
  }
  const out: Record<string, string | null> = {};
  for (const [key, entry] of entries) {
    text(key, `${label} key`, MCP_LIMITS.key);
    if (entry !== null && typeof entry !== "string") {
      throw new Error(`${label} values must be a string or null`);
    }
    out[key] = entry === null ? null : text(entry, `${label} value`, MCP_LIMITS.value);
  }
  return out;
}

export function mcpServerInput(value: unknown): McpServerInput {
  if (!isObject(value)) throw new Error("server must be an object");
  const name = text(value.name, "server.name", MCP_LIMITS.name);
  const transport = value.transport;
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw new Error("server.transport must be stdio, http or sse");
  }
  const args: unknown = value.args;
  if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === "string"))) {
    throw new Error("server.args must be a list of strings");
  }
  if (args !== undefined && args.length > MCP_LIMITS.args) {
    throw new Error(`server.args has more than ${MCP_LIMITS.args} items`);
  }
  for (const arg of args ?? []) text(arg, "an argument", MCP_LIMITS.arg);
  const command = optionalText(value.command, "server.command", MCP_LIMITS.command);
  const url = optionalText(value.url, "server.url", MCP_LIMITS.url);
  const env = secretMap(value.env, "server.env");
  const headers = secretMap(value.headers, "server.headers");
  return {
    name,
    transport: transport satisfies McpTransport,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args: args as string[] }),
    ...(url === undefined ? {} : { url }),
    ...(env === undefined ? {} : { env }),
    ...(headers === undefined ? {} : { headers }),
  };
}

export function mcpSecretRef(value: unknown): McpSecretRef {
  if (!isObject(value)) throw new Error("secret must be an object");
  if (value.kind === "url") return { kind: "url" };
  if (value.kind === "env" || value.kind === "header") {
    return { kind: value.kind, key: text(value.key, "secret.key", MCP_LIMITS.key) };
  }
  throw new Error("secret.kind must be env, header or url");
}

export function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
