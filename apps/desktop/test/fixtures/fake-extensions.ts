/**
 * `mcp.*` and `skills.*` for the fake sidecar: an in-memory copy of the two `mcp.json` files and
 * the skills omp would find, so the screen can be driven (and photographed) without a live omp.
 * The server and skill names are invented. The refusals mimic the real sidecar's shape (a field
 * and a sentence), but the validation rules here are only the ones the tests and screenshots
 * need: the real ones are omp's own (`validateServerConfig`).
 *
 * FAKE_MCP picks the starting state: `default`, `empty` (no servers anywhere, no skills) or
 * `broken` (the global file does not parse), `locked` (the project scope lists but every write to it
 * is refused, as for a session in the home directory) or `inactive` (omp is told to start no project
 * servers) or `refuse` (every toggle is refused, as when another process holds the file).
 */

import {
  errorResponse,
  type McpListing,
  type McpServerEntry,
  okResponse,
  type ResponseEnvelope,
  type SettingScope,
  type SkillEntry,
} from "@omp-app/protocol";

interface Stored {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  enabled: boolean;
}

const MASK = "•••";
const GLOBAL_FILE = "/tmp/omp-app-fake/agent/mcp.json";

const stdio = (name: string, command: string, args: string[], extra: Partial<Stored> = {}) =>
  ({
    name,
    transport: "stdio",
    command,
    args,
    env: {},
    headers: {},
    enabled: true,
    ...extra,
  }) satisfies Stored;

function seedGlobal(): Stored[] {
  return [
    {
      name: "linear",
      transport: "http",
      url: "https://user:hunter2@mcp.example.test/sse?token=abc123",
      args: [],
      env: {},
      headers: { Authorization: "Bearer sk-fake-0000-91c0" },
      enabled: true,
    },
    stdio("context7", "npx", ["-y", "@example/context7-mcp"], {
      env: { API_KEY: "fake-env-secret" },
    }),
    stdio("playwright", "npx", ["@example/playwright-mcp"]),
  ];
}

const seedProject = (): Stored[] => [
  stdio("filesystem", "node", ["./servers/fs.js"], { enabled: false }),
];

const SKILLS: readonly SkillEntry[] = [
  {
    name: "pen-dev",
    description: "Design on the canvas: schema, execute, components.",
    origin: "project",
    provider: "OMP",
    state: "active",
    toggleable: true,
  },
  {
    name: "sidecar-contract",
    description: "Checks a change against the sidecar contract before planning.",
    origin: "project",
    provider: "OMP",
    state: "active",
    toggleable: true,
  },
  {
    name: "commit",
    description: "Writes the commit message from the staged diff.",
    origin: "user",
    provider: "OMP",
    state: "active",
    toggleable: true,
  },
  {
    name: "review-pr",
    description: "Reviews a pull request and leaves line comments.",
    origin: "user",
    provider: "OMP",
    state: "active",
    toggleable: true,
  },
  {
    name: "mcp-builder",
    description: "Scaffolds a new MCP server in TypeScript or Python.",
    origin: "user",
    provider: "OMP",
    state: "disabled",
    reason: "You turned it off.",
    toggleable: true,
  },
  {
    name: "pdf",
    description: "Reads, fills and merges PDF files.",
    origin: "user",
    provider: "Claude Code",
    state: "disabled",
    reason:
      "Skills from this tool’s folder in your home directory are off until you turn that source on.",
    toggleable: false,
  },
  {
    name: "release-notes",
    description: "Drafts notes from merged pull requests.",
    origin: "plugin",
    provider: "Example plugin",
    state: "active",
    toggleable: true,
  },
];

interface World {
  global: Stored[];
  project: Map<string, Stored[]>;
  off: Set<string>;
  mode: string;
}

const world: World = {
  global: process.env.FAKE_MCP === "empty" ? [] : seedGlobal(),
  project: new Map(),
  off: new Set(["mcp-builder"]),
  mode: process.env.FAKE_MCP ?? "default",
};

const projectServers = (cwd: string): Stored[] => {
  let list = world.project.get(cwd);
  if (list === undefined) {
    list = world.mode === "empty" ? [] : seedProject();
    world.project.set(cwd, list);
  }
  return list;
};

function field(params: unknown, key: string): unknown {
  return typeof params === "object" && params !== null ? Reflect.get(params, key) : undefined;
}
const str = (params: unknown, key: string): string | undefined => {
  const v = field(params, key);
  return typeof v === "string" ? v : undefined;
};

function redact(url: string): { url: string; redacted: boolean } {
  const m = /^(https?:\/\/)(?:[^@/?#]*@)?([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(url);
  if (!m) return { url, redacted: false };
  const userinfo = /^https?:\/\/[^@/?#]*@/.test(url);
  const query = m[4];
  const masked = query
    ?.split("&")
    .map((p) => (p.includes("=") ? `${p.split("=")[0]}=${MASK}` : MASK))
    .join("&");
  return {
    url: `${m[1]}${userinfo ? `${MASK}@` : ""}${m[2]}${m[3]}${masked === undefined ? "" : `?${masked}`}${m[5] === undefined ? "" : `#${MASK}`}`,
    redacted: userinfo || query !== undefined || m[5] !== undefined,
  };
}

function entryOf(s: Stored): McpServerEntry {
  const shown = s.url === undefined ? undefined : redact(s.url);
  return {
    name: s.name,
    transport: s.transport,
    ...(s.command === undefined ? {} : { command: s.command }),
    args: s.args,
    ...(shown === undefined ? {} : { url: shown.url }),
    urlRedacted: shown?.redacted === true,
    envKeys: Object.keys(s.env),
    headerKeys: Object.keys(s.headers),
    enabled: s.enabled,
  };
}

function listingOf(scope: SettingScope, cwd: string | undefined): McpListing {
  if (scope === "project") {
    const file = `${cwd}/.omp/mcp.json`;
    const servers = projectServers(cwd ?? "").map(entryOf);
    if (world.mode === "locked") {
      return {
        scope,
        file,
        servers,
        locked:
          "This session runs in your home directory. omp starts the servers of this file, but the app doesn’t edit it from here.",
      };
    }
    if (world.mode === "inactive") {
      return {
        scope,
        file,
        servers,
        inactive:
          "Project servers are switched off in omp’s settings (mcp.enableProjectConfig), so a new session starts none of them.",
      };
    }
    return { scope, file, servers };
  }
  if (world.mode === "broken") {
    return {
      scope,
      file: GLOBAL_FILE,
      servers: [],
      error:
        "This mcp.json isn’t valid JSON, so omp can’t read it. Fix it by hand; the app won’t change it.",
    };
  }
  return { scope, file: GLOBAL_FILE, servers: world.global.map(entryOf) };
}

const refuse = (id: string, message: string, fieldName?: string): ResponseEnvelope =>
  okResponse(id, { ok: false, message, ...(fieldName === undefined ? {} : { field: fieldName }) });

function readOnlyError(id: string, method: string): ResponseEnvelope {
  return errorResponse(id, {
    code: "read_only",
    message: `${method} writes and the shared omp database is newer than this app supports`,
  });
}

const WRITES = new Set([
  "mcp.add",
  "mcp.update",
  "mcp.remove",
  "mcp.setEnabled",
  "skills.setEnabled",
]);

function secretMap(sent: unknown, stored: Record<string, string>): Record<string, string> | string {
  const out: Record<string, string> = {};
  if (typeof sent !== "object" || sent === null) return out;
  for (const [key, value] of Object.entries(sent)) {
    if (value === null) {
      if (!Object.hasOwn(stored, key)) return `“${key}” has no stored value to keep.`;
      out[key] = stored[key] as string;
    } else if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function handleExtensions(
  method: string,
  id: string,
  params: unknown,
  readOnly: boolean,
  cwdOf: (sessionId: string) => string | undefined,
): ResponseEnvelope | undefined {
  if (!method.startsWith("mcp.") && !method.startsWith("skills.")) return undefined;
  if (readOnly && WRITES.has(method)) return readOnlyError(id, method);

  if (world.mode === "refuse" && (method === "mcp.setEnabled" || method === "skills.setEnabled")) {
    return refuse(id, "Another process is writing this file. Try again in a moment.");
  }

  if (method.startsWith("skills.")) {
    const skills = (): SkillEntry[] =>
      world.mode === "empty"
        ? []
        : SKILLS.map((s) =>
            s.toggleable
              ? world.off.has(s.name)
                ? { ...s, state: "disabled", reason: "You turned it off." }
                : { ...s, state: "active" }
              : s,
          ).map(({ reason, ...rest }) =>
            rest.state === "active" ? rest : { ...rest, ...(reason ? { reason } : {}) },
          );
    if (method === "skills.list") return okResponse(id, { skills: skills() });
    const name = str(params, "name") ?? "";
    const enabled = field(params, "enabled") === true;
    if (!SKILLS.some((s) => s.name === name && s.toggleable)) {
      return refuse(id, `There is no skill named “${name}”.`);
    }
    if (enabled) world.off.delete(name);
    else world.off.add(name);
    return okResponse(id, { ok: true, listing: { skills: skills() } });
  }

  const scope: SettingScope = str(params, "scope") === "project" ? "project" : "global";
  const sessionId = str(params, "sessionId");
  const cwd = sessionId === undefined ? undefined : cwdOf(sessionId);
  if (scope === "project" && cwd === undefined) {
    return errorResponse(id, { code: "internal", message: "the project scope needs a session" });
  }
  const list = scope === "project" ? projectServers(cwd ?? "") : world.global;
  const listing = (): McpListing => listingOf(scope, cwd);

  if (method === "mcp.list") return okResponse(id, listing());
  if (scope === "global" && world.mode === "broken" && WRITES.has(method)) {
    return refuse(id, listing().error ?? "");
  }
  if (scope === "project" && world.mode === "locked" && WRITES.has(method)) {
    return refuse(id, listing().locked ?? "");
  }

  const find = (name: string) => list.find((s) => s.name === name);

  if (method === "mcp.reveal") {
    const server = find(str(params, "name") ?? "");
    const secret = field(params, "secret");
    const kind = str(secret, "kind");
    const key = str(secret, "key") ?? "";
    const value =
      kind === "url" ? server?.url : kind === "env" ? server?.env[key] : server?.headers[key];
    return value === undefined
      ? errorResponse(id, { code: "internal", message: "no such stored value" })
      : okResponse(id, { value });
  }

  if (method === "mcp.remove" || method === "mcp.setEnabled") {
    const name = str(params, "name") ?? "";
    const server = find(name);
    if (server === undefined)
      return refuse(id, `There is no server named “${name}” in this scope.`);
    if (method === "mcp.remove") list.splice(list.indexOf(server), 1);
    else server.enabled = field(params, "enabled") === true;
    return okResponse(id, { ok: true, listing: listing() });
  }

  // mcp.add | mcp.update
  const input = field(params, "server");
  const name = (str(input, "name") ?? "").trim();
  const adding = method === "mcp.add";
  const existing = find(name);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    return refuse(
      id,
      "Server name can only contain letters, numbers, dashes, underscores and dots.",
      "name",
    );
  }
  if (adding && existing)
    return refuse(id, `A server named “${name}” already exists in this scope.`, "name");
  if (!adding && !existing) return refuse(id, `There is no server named “${name}” in this scope.`);
  const transport = str(input, "transport");
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    return errorResponse(id, { code: "internal", message: "unknown transport" });
  }
  const next: Stored = {
    name,
    transport,
    args: [],
    env: {},
    headers: {},
    enabled: existing?.enabled ?? true,
  };
  if (transport === "stdio") {
    const command = (str(input, "command") ?? "").trim();
    if (command === "") {
      return refuse(id, `Server "${name}": stdio server requires "command" field`, "command");
    }
    const env = secretMap(field(input, "env"), existing?.env ?? {});
    if (typeof env === "string") return refuse(id, env, "env");
    const args = field(input, "args");
    next.command = command;
    next.args = Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [];
    next.env = env;
  } else {
    const typed = (str(input, "url") ?? "").trim();
    const url =
      typed === "" ? existing?.url : /^https?:\/\//i.test(typed) ? typed : `https://${typed}`;
    if (url === undefined || url === "") {
      return refuse(id, `Server "${name}": ${transport} server requires "url" field`, "url");
    }
    const headers = secretMap(field(input, "headers"), existing?.headers ?? {});
    if (typeof headers === "string") return refuse(id, headers, "headers");
    next.url = url;
    next.headers = headers;
  }
  if (existing) list.splice(list.indexOf(existing), 1, next);
  else list.push(next);
  return okResponse(id, { ok: true, listing: listing() });
}
