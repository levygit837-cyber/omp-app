import type {
  McpServerEntry,
  McpServerInput,
  McpTransport,
  SessionWarning,
  SkillEntry,
  SkillOrigin,
} from "@omp-app/protocol";

/** A key/value row of the form (environment variable or header). */
export interface SecretRow {
  readonly key: string;
  /** What the person typed. Unused while `stored` is true. */
  readonly value: string;
  /** The value lives in the file and has not been retyped: the form sends `null` for it. */
  readonly stored: boolean;
}

export interface ServerDraft {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string;
  /** One line, split like a shell would (`splitArgs`). */
  readonly args: string;
  readonly url: string;
  readonly env: readonly SecretRow[];
  readonly headers: readonly SecretRow[];
}

export const EMPTY_DRAFT: ServerDraft = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: [],
  headers: [],
};

/**
 * Splits an argument line the way a shell would for the cases an MCP command needs: whitespace
 * separates, single or double quotes group, a backslash escapes the next character outside single
 * quotes. An unterminated quote keeps what follows as one argument.
 */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
    } else if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      started = true;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current !== "") out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started || current !== "") out.push(current);
  return out;
}

/** Ids of the notes that disabled controls point to (`aria-describedby`). */
export const READ_ONLY_NOTE_ID = "extensions-read-only-note";
export const LOCKED_NOTE_ID = "mcp-locked-note";
export const INACTIVE_NOTE_ID = "mcp-inactive-note";

/** Whether the form holds anything the person typed or changed since it opened. */
export function draftChanged(initial: ServerDraft, draft: ServerDraft): boolean {
  return JSON.stringify(initial) !== JSON.stringify(draft);
}

/** The inverse of `splitArgs`: `splitArgs(joinArgs(a))` equals `a`. */
export function joinArgs(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg !== "" && !/[\s"'\\]/.test(arg)) return arg;
      return `"${arg.replace(/(["\\])/g, "\\$1")}"`;
    })
    .join(" ");
}

/** The form for an existing server: stored values stay out of it and come back as `null`. */
export function draftOf(entry: McpServerEntry): ServerDraft {
  const stored = (keys: readonly string[]): SecretRow[] =>
    keys.map((key) => ({ key, value: "", stored: true }));
  return {
    name: entry.name,
    transport: entry.transport,
    command: entry.command ?? "",
    args: joinArgs(entry.args),
    // A redacted URL cannot be sent back: the form starts empty and an empty URL keeps the stored one.
    url: entry.urlRedacted ? "" : (entry.url ?? ""),
    env: stored(entry.envKeys),
    headers: stored(entry.headerKeys),
  };
}

function secretMap(rows: readonly SecretRow[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const row of rows) {
    // A row without a key is a row the person has not filled in yet; it is not sent.
    if (row.key.trim() === "") continue;
    out[row.key.trim()] = row.stored ? null : row.value;
  }
  return out;
}

/** What the form sends. Fields of the other transport are left out, so a switch drops them. */
export function inputOf(draft: ServerDraft): McpServerInput {
  const name = draft.name.trim();
  if (draft.transport === "stdio") {
    const args = splitArgs(draft.args);
    const env = secretMap(draft.env);
    return {
      name,
      transport: "stdio",
      command: draft.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  const headers = secretMap(draft.headers);
  return {
    name,
    transport: draft.transport,
    ...(draft.url.trim() === "" ? {} : { url: draft.url.trim() }),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/** Two rows with the same key would collapse into one entry; the form says so before sending. */
export function duplicateKey(rows: readonly SecretRow[]): string | null {
  const seen: Record<string, true> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    if (Object.hasOwn(seen, key)) return key;
    seen[key] = true;
  }
  return null;
}

/** The server's one-line summary in the list: what it runs or where it connects. */
export function serverTarget(entry: McpServerEntry): string {
  if (entry.transport === "stdio") {
    return [entry.command ?? "", ...entry.args].join(" ").trim();
  }
  return entry.url ?? "";
}

function includes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

export function filterServers(
  servers: readonly McpServerEntry[],
  query: string,
): readonly McpServerEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return servers;
  return servers.filter((s) => includes(s.name, q) || includes(serverTarget(s), q));
}

export function filterSkills(skills: readonly SkillEntry[], query: string): readonly SkillEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return skills;
  return skills.filter((s) => includes(s.name, q) || includes(s.description ?? "", q));
}

export interface SkillGroup {
  readonly origin: SkillOrigin;
  readonly skills: readonly SkillEntry[];
}

const ORIGIN_ORDER: readonly SkillOrigin[] = ["project", "user", "plugin"];

/** Project first (it is the narrowest), then the user's, then plugins. Empty groups are dropped. */
export function groupSkills(skills: readonly SkillEntry[]): SkillGroup[] {
  return ORIGIN_ORDER.map((origin) => ({
    origin,
    skills: skills.filter((s) => s.origin === origin),
  })).filter((group) => group.skills.length > 0);
}

/**
 * The failure omp reported for each server in the open session, by server name: the latest
 * message wins. These are the only start failures the app knows about; a server that works, or
 * that no open session has tried, has no entry.
 */
export function failuresByServer(
  warnings: readonly SessionWarning[] | undefined,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const warning of warnings ?? []) {
    if (warning.source === "mcp") out[warning.server] = warning.message;
  }
  return out;
}

/** Said once after a write lands, for the screen reader (the screen's live region). */
export function savedSentence(kind: "added" | "updated" | "removed", name: string): string {
  return `${name} ${kind}. Applies to new sessions.`;
}

export function toggledSentence(name: string, enabled: boolean): string {
  return `${name} ${enabled ? "on" : "off"}. Applies to new sessions.`;
}
