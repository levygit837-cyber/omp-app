/**
 * MCP servers and skills screen contract. The sidecar reads and writes omp's own files with
 * omp's own writer (`mcp/config-writer.ts`) and loader, so the app never hand-writes either.
 * Secrets never appear in a listing: environment and header values are withheld, and a URL
 * that carries credentials is shown redacted. `mcp.reveal` hands out one value on demand.
 */

import { isRecord } from "./guards";
import type { SettingScope } from "./settings";

export type McpTransport = "stdio" | "http" | "sse";

/** One server of a scope's `mcp.json`. */
export interface McpServerEntry {
  readonly name: string;
  readonly transport: McpTransport;
  /** stdio only. */
  readonly command?: string;
  readonly args: readonly string[];
  /** http and sse only. Userinfo and query values are replaced by `•••`; see `urlRedacted`. */
  readonly url?: string;
  /** The stored URL holds credentials (userinfo or query): `url` is a redacted copy. */
  readonly urlRedacted: boolean;
  /** Names only. Values are withheld; `mcp.reveal` returns one. */
  readonly envKeys: readonly string[];
  readonly headerKeys: readonly string[];
  /**
   * What a new session will do with it: `enabled: false` on the entry or a name on the user
   * `disabledServers` list turns it off (`mcp/config.ts:140-146` [V]).
   */
  readonly enabled: boolean;
  /** omp's own objection to this entry as stored (a hand-edited file); a new session cannot start it. */
  readonly problem?: string;
}

export interface McpListing {
  readonly scope: SettingScope;
  /** The `mcp.json` this scope reads and writes; `null` where omp reads none (a session in the home directory). */
  readonly file: string;
  readonly servers: readonly McpServerEntry[];
  /** Why the scope cannot be listed: the file does not parse or cannot be read. `servers` is empty and writes are refused. */
  readonly error?: string;
  /** Why every write to this scope is refused although it lists (the project file of a session in the home directory). */
  readonly locked?: string;
  /** Why a new session ignores this whole scope although it lists (`mcp.enableProjectConfig` is off). */
  readonly inactive?: string;
}

/**
 * Sizes the form may send, checked at the Electron door and again in the sidecar. Generous for
 * real servers, small enough that a runaway renderer cannot fill an `mcp.json`.
 */
export const MCP_LIMITS = {
  /** `validateServerName` (omp) allows 100. */
  name: 100,
  command: 4096,
  url: 4096,
  args: 256,
  arg: 8192,
  entries: 128,
  key: 256,
  value: 16384,
} as const;

/** The form fields a refusal can point at. */
export type McpField = "name" | "command" | "url" | "env" | "headers";

/**
 * A server as the form sends it. `env` and `headers` map a key to its new value, or to `null`
 * to keep the value stored for that key (the form never receives stored values).
 */
export interface McpServerInput {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  /** On update, omitted keeps the stored URL. */
  readonly url?: string;
  readonly env?: Readonly<Record<string, string | null>>;
  readonly headers?: Readonly<Record<string, string | null>>;
}

/** Result of a write: a refusal is data, with omp's own sentence. */
export type McpChange =
  | { readonly ok: true; readonly listing: McpListing }
  | { readonly ok: false; readonly message: string; readonly field?: McpField };

/** One stored value `mcp.reveal` may return. */
export type McpSecretRef =
  | { readonly kind: "env" | "header"; readonly key: string }
  | { readonly kind: "url" };

export type SkillOrigin = "user" | "project" | "plugin";

export type SkillState = "active" | "disabled" | "shadowed";

export interface SkillEntry {
  readonly name: string;
  readonly description?: string;
  readonly origin: SkillOrigin;
  /** omp's display name of the provider that found it (`Claude Code`, `OMP`). */
  readonly provider: string;
  readonly state: SkillState;
  /** Why it is not active, as a sentence. */
  readonly reason?: string;
  /** The toggle changes what a new session loads. False for a shadowed skill or a switched-off source. */
  readonly toggleable: boolean;
}

export interface SkillsListing {
  readonly skills: readonly SkillEntry[];
  /** The settings file that decides what is disabled cannot be read; `skills` is empty. */
  readonly error?: string;
}

export type SkillsChange =
  | { readonly ok: true; readonly listing: SkillsListing }
  | { readonly ok: false; readonly message: string };

const isString = (v: unknown): v is string => typeof v === "string";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function isMcpServerEntry(v: unknown): v is McpServerEntry {
  return (
    isRecord(v) &&
    isString(v.name) &&
    (v.transport === "stdio" || v.transport === "http" || v.transport === "sse") &&
    (v.command === undefined || isString(v.command)) &&
    isStrings(v.args) &&
    (v.url === undefined || isString(v.url)) &&
    typeof v.urlRedacted === "boolean" &&
    isStrings(v.envKeys) &&
    isStrings(v.headerKeys) &&
    typeof v.enabled === "boolean" &&
    (v.problem === undefined || isString(v.problem))
  );
}

export function isMcpListing(v: unknown): v is McpListing {
  return (
    isRecord(v) &&
    (v.scope === "global" || v.scope === "project") &&
    isString(v.file) &&
    Array.isArray(v.servers) &&
    v.servers.every(isMcpServerEntry) &&
    (v.error === undefined || isString(v.error)) &&
    (v.locked === undefined || isString(v.locked)) &&
    (v.inactive === undefined || isString(v.inactive))
  );
}

const FIELDS: readonly string[] = ["name", "command", "url", "env", "headers"];

export function isMcpChange(v: unknown): v is McpChange {
  if (!isRecord(v)) return false;
  if (v.ok === true) return isMcpListing(v.listing);
  return (
    v.ok === false &&
    isString(v.message) &&
    (v.field === undefined || FIELDS.includes(v.field as string))
  );
}

function isSkillEntry(v: unknown): v is SkillEntry {
  return (
    isRecord(v) &&
    isString(v.name) &&
    (v.description === undefined || isString(v.description)) &&
    (v.origin === "user" || v.origin === "project" || v.origin === "plugin") &&
    isString(v.provider) &&
    (v.state === "active" || v.state === "disabled" || v.state === "shadowed") &&
    (v.reason === undefined || isString(v.reason)) &&
    typeof v.toggleable === "boolean"
  );
}

export function isSkillsListing(v: unknown): v is SkillsListing {
  return (
    isRecord(v) &&
    Array.isArray(v.skills) &&
    v.skills.every(isSkillEntry) &&
    (v.error === undefined || isString(v.error))
  );
}

export function isSkillsChange(v: unknown): v is SkillsChange {
  if (!isRecord(v)) return false;
  if (v.ok === true) return isSkillsListing(v.listing);
  return v.ok === false && isString(v.message);
}
