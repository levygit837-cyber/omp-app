import { validateServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { readMCPConfigFile, validateServerName } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPConfigFile, MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
  MCP_LIMITS,
  type McpField,
  type McpServerEntry,
  type McpServerInput,
  type McpTransport,
} from "@omp-app/protocol";

/** What the listing shows in place of a secret part of a URL. */
export const MASK = "•••";

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

export type McpRead = { readonly config: MCPConfigFile } | { readonly error: string };

export const MALFORMED_MESSAGE =
  "This mcp.json isn’t valid JSON, so omp can’t read it. Fix it by hand; the app won’t change it.";

/**
 * Reads one `mcp.json` with omp's own reader (`readMCPConfigFile`, `mcp/config-writer.ts` [V]):
 * a missing file is an empty config, one that does not parse is an error and is never fixed here.
 */
export async function readMcpFile(file: string): Promise<McpRead> {
  let config: unknown;
  try {
    config = await readMCPConfigFile(file);
  } catch (error) {
    if (error instanceof SyntaxError) return { error: MALFORMED_MESSAGE };
    const code = (error as { code?: unknown }).code;
    return { error: `Couldn’t read this mcp.json${typeof code === "string" ? ` (${code})` : ""}.` };
  }
  if (!isRaw(config))
    return { error: "This mcp.json must hold a JSON object, so omp can’t read it." };
  if (config.mcpServers !== undefined && !isRaw(config.mcpServers)) {
    return { error: "In this mcp.json, mcpServers must be an object, so omp can’t read it." };
  }
  return { config: config as MCPConfigFile };
}

/**
 * Hides what a URL may carry as a secret: the userinfo before `@`, every query value (a pair
 * without `=` is hidden whole, as its whole text may be the token) and the fragment. Host, path
 * and query keys stay, so the line still says which server it is. A string that does not parse
 * as a URL (no scheme) is cut at its first `?` or `#`: everything after it is hidden.
 * Not detected: a secret in the path or the host.
 */
export function redactUrl(url: string): { readonly url: string; readonly redacted: boolean } {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(url);
  if (!match) {
    const cut = url.search(/[?#]/);
    return cut < 0
      ? { url, redacted: false }
      : { url: `${url.slice(0, cut + 1)}${MASK}`, redacted: true };
  }
  const [, scheme = "", authority = "", path = "", query, fragment] = match;
  const at = authority.lastIndexOf("@");
  const host = at >= 0 ? `${MASK}@${authority.slice(at + 1)}` : authority;
  const maskedQuery =
    query === undefined || query === ""
      ? ""
      : `?${query
          .split("&")
          .map((pair) =>
            pair.includes("=") ? `${pair.slice(0, pair.indexOf("="))}=${MASK}` : MASK,
          )
          .join("&")}`;
  return {
    url: `${scheme}${host}${path}${maskedQuery}${fragment === undefined ? "" : `#${MASK}`}`,
    redacted: at >= 0 || maskedQuery !== "" || fragment !== undefined,
  };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const stringMap = (v: unknown): Record<string, string> =>
  isRaw(v)
    ? Object.fromEntries(
        Object.entries(v).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
      )
    : {};

/**
 * Whether a new session will start the server, as omp's loader decides it
 * (`loadAllMCPConfigs`, `mcp/config.ts:131-146` [V]): a name on the user `disabledServers` list
 * wins over everything; `enabled: false` on the entry disables it unless the user
 * `enabledServers` list forces it back on.
 */
export function isEnabled(name: string, config: Raw, userFile: MCPConfigFile): boolean {
  if (strings(userFile.disabledServers).includes(name)) return false;
  if (config.enabled === false && !strings(userFile.enabledServers).includes(name)) return false;
  return true;
}

export function toEntry(name: string, config: Raw, enabled: boolean): McpServerEntry {
  const type = config.type;
  const transport: McpTransport = type === "http" || type === "sse" ? type : "stdio";
  const stored = typeof config.url === "string" ? config.url : undefined;
  const url = stored === undefined ? undefined : redactUrl(stored);
  const problem = validateServerConfig(name, config as unknown as MCPServerConfig)[0];
  return {
    name,
    transport,
    ...(typeof config.command === "string" ? { command: config.command } : {}),
    args: strings(config.args),
    ...(url === undefined ? {} : { url: url.url }),
    urlRedacted: url?.redacted === true,
    envKeys: Object.keys(stringMap(config.env)),
    headerKeys: Object.keys(stringMap(config.headers)),
    enabled,
    ...(problem === undefined ? {} : { problem }),
  };
}

export type Built =
  | { readonly config: MCPServerConfig }
  | { readonly message: string; readonly field?: McpField };

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The fields of an entry that belong to one transport; a change of transport drops them. */
const TRANSPORT_FIELDS = [
  "type",
  "command",
  "args",
  "env",
  "envPolicy",
  "envLiteralKeys",
  "cwd",
  "url",
  "headers",
  "headerPolicy",
] as const;
/** Kept only while the transport stays the same (the form carries none of them). */
const SAME_TRANSPORT_KEPT = ["envPolicy", "envLiteralKeys", "cwd", "headerPolicy"] as const;

function fail(message: string, field?: McpField): Built {
  return field === undefined ? { message } : { message, field };
}

/** The field a message of omp's validation is about. */
function fieldOf(message: string): McpField | undefined {
  if (message.includes('"command"')) return "command";
  if (message.includes('"url"')) return "url";
  return undefined;
}

/**
 * Whether `value` has the shape of an `McpServerInput`. The sidecar does not trust its caller:
 * the params come over a socket from a renderer. Throws for a shape the form can never send.
 */
export function assertServerInput(value: unknown): asserts value is McpServerInput {
  if (!isRaw(value)) throw new Error("server must be an object");
  const { name, transport, command, args, url, env, headers } = value;
  const text = (v: unknown, label: string, max: number): void => {
    if (typeof v !== "string") throw new Error(`${label} must be a string`);
    if (v.length > max) throw new Error(`${label} is longer than ${max} characters`);
  };
  text(name, "server.name", MCP_LIMITS.name);
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    throw new Error(`unknown transport: ${String(transport)}`);
  }
  if (command !== undefined) text(command, "command", MCP_LIMITS.command);
  if (args !== undefined) {
    if (!(Array.isArray(args) && args.every((a) => typeof a === "string"))) {
      throw new Error("args must be a list of strings");
    }
    if (args.length > MCP_LIMITS.args)
      throw new Error(`args has more than ${MCP_LIMITS.args} items`);
    for (const arg of args) text(arg, "an argument", MCP_LIMITS.arg);
  }
  if (url !== undefined) text(url, "url", MCP_LIMITS.url);
  for (const map of [env, headers]) {
    if (map === undefined) continue;
    if (!isRaw(map) || !Object.values(map).every((v) => v === null || typeof v === "string")) {
      throw new Error("env and headers must map keys to a string or null");
    }
    const entries = Object.entries(map);
    if (entries.length > MCP_LIMITS.entries) {
      throw new Error(`env and headers hold at most ${MCP_LIMITS.entries} entries`);
    }
    for (const [key, entry] of entries) {
      text(key, "a key", MCP_LIMITS.key);
      if (entry !== null) text(entry, "a value", MCP_LIMITS.value);
    }
  }
}

/** Resolves `null` values against the stored map: the form never holds stored secrets. */
function mergeSecrets(
  sent: Readonly<Record<string, string | null>> | undefined,
  stored: Record<string, string>,
  field: "env" | "headers",
): { readonly values: Record<string, string> } | { readonly refusal: Built } {
  const refuse = (message: string) => ({ refusal: fail(message, field) });
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(sent ?? {})) {
    const key = rawKey.trim();
    if (key === "") return refuse("A key can’t be empty.");
    if (field === "env" && /[=\0]/.test(key)) {
      return refuse(`“${key}” can’t be an environment variable name.`);
    }
    if (field === "headers" && !HEADER_NAME.test(key)) {
      return refuse(`“${key}” isn’t a valid header name.`);
    }
    if (Object.hasOwn(out, key)) return refuse(`“${key}” appears twice.`);
    if (value !== null) {
      out[key] = value;
    } else if (Object.hasOwn(stored, rawKey)) {
      out[key] = stored[rawKey] as string;
    } else {
      return refuse(`“${key}” has no stored value to keep.`);
    }
  }
  return { values: out };
}

/**
 * Turns the form into the config omp stores, after omp's own checks (`validateServerName`,
 * `validateServerConfig`, the ones its writer runs). `stored` is the current entry on an
 * update: fields the form does not carry (timeout, auth, enabled) survive, and so do the
 * values behind `null`. Key order follows what `/mcp add` writes (`slash-commands/helpers/
 * mcp.ts:312-322` [V]): `type`, then `command`, `args` or `url`, `headers`.
 */
export function buildConfig(input: McpServerInput, stored?: Raw): Built {
  const name = input.name.trim();
  const nameError = validateServerName(name);
  if (nameError !== undefined) return fail(nameError, "name");

  const sameTransport =
    stored !== undefined && ((stored.type ?? "stdio") as unknown) === input.transport;
  const kept: Raw = {};
  if (stored !== undefined) {
    for (const [key, value] of Object.entries(stored)) {
      const owned = (TRANSPORT_FIELDS as readonly string[]).includes(key);
      const survives = (SAME_TRANSPORT_KEPT as readonly string[]).includes(key) && sameTransport;
      if (!owned || survives) kept[key] = value;
    }
  }

  let fresh: Raw;
  if (input.transport === "stdio") {
    const command = (input.command ?? "").trim();
    const args = (input.args ?? []).filter((a) => a !== "");
    const merged = mergeSecrets(input.env, sameTransport ? stringMap(stored?.env) : {}, "env");
    if ("refusal" in merged) return merged.refusal;
    const env = merged.values;
    fresh = {
      type: "stdio",
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  } else {
    const keptUrl = sameTransport && typeof stored?.url === "string" ? stored.url : undefined;
    const typed = input.url === undefined ? undefined : input.url.trim();
    // `/mcp add` prefixes https:// when the URL has no http(s) scheme (`slash-commands/helpers/mcp.ts:314` [V]).
    const url =
      typed === undefined
        ? (keptUrl ?? "")
        : typed === "" || /^https?:\/\//i.test(typed)
          ? typed
          : `https://${typed}`;
    const merged = mergeSecrets(
      input.headers,
      sameTransport ? stringMap(stored?.headers) : {},
      "headers",
    );
    if ("refusal" in merged) return merged.refusal;
    const headers = merged.values;
    fresh = {
      type: input.transport,
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  const config = { ...fresh, ...kept } as unknown as MCPServerConfig;
  const errors = validateServerConfig(name, config);
  if (errors.length > 0) return fail(errors.join(" "), fieldOf(errors.join(" ")));
  return { config };
}

/** An omp refusal as a sentence for the person; `field` points at the control it is about. */
export function describeWriteError(
  error: unknown,
  name: string,
): { readonly message: string; readonly field?: McpField } {
  if (error instanceof SyntaxError) return { message: MALFORMED_MESSAGE };
  const text = error instanceof Error ? error.message : String(error);
  if (/ already exists in /.test(text)) {
    return { message: `A server named “${name}” already exists in this scope.`, field: "name" };
  }
  if (/ not found in /.test(text)) {
    return { message: `There is no server named “${name}” in this scope.` };
  }
  if (/^Failed to acquire lock/.test(text)) {
    return { message: "Another process is writing this file. Try again in a moment." };
  }
  const invalid = /^Invalid server config: ([\s\S]*)$/.exec(text);
  if (invalid?.[1] !== undefined) {
    const field = fieldOf(invalid[1]);
    return field === undefined ? { message: invalid[1] } : { message: invalid[1], field };
  }
  const code = (error as { code?: unknown }).code;
  return {
    message: `Couldn’t save the change${typeof code === "string" ? ` (${code})` : ""}.`,
  };
}
