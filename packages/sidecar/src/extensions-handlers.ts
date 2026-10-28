import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import {
  addMCPServer,
  removeMCPServer,
  setMcpServerEnabled,
  updateMCPServer,
} from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { loadAllExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import type {
  McpChange,
  McpListing,
  McpSecretRef,
  McpServerInput,
  SettingsTarget,
  SkillEntry,
  SkillOrigin,
  SkillsChange,
  SkillsListing,
} from "@omp-app/protocol";
import {
  assertServerInput,
  buildConfig,
  describeWriteError,
  isEnabled,
  readMcpFile,
  toEntry,
} from "./mcp-files";
import type { Handlers } from "./server";
import { getByPath } from "./settings-catalog";
import { globalConfigFile, readLayer, readProjectLayer } from "./settings-files";
import { parseTarget, type SettingsControl, type Target } from "./settings-handlers";

export const MCP_CAPABILITIES = [
  "mcp.list",
  "mcp.add",
  "mcp.update",
  "mcp.remove",
  "mcp.setEnabled",
  "mcp.reveal",
] as const;
export const SKILLS_CAPABILITIES = ["skills.list", "skills.setEnabled"] as const;

type Capability = (typeof MCP_CAPABILITIES)[number] | (typeof SKILLS_CAPABILITIES)[number];

/** Nothing here applies to a running session: omp reads both files when a session starts. */
const HOME_MESSAGE =
  "This session runs in your home directory. omp starts the servers of this file, but the app doesn’t edit it from here.";

const PROJECT_OFF_MESSAGE =
  "Project servers are switched off in omp’s settings (mcp.enableProjectConfig), so a new session starts none of them.";

/**
 * The file a scope reads, or why there is none. In the home directory omp reads
 * `<home>/.omp/mcp.json` as the project file (probe of omp 18.12.6 [V]); the app lists it and
 * refuses to write it (`HOME_MESSAGE`), as it does for every project setting there.
 */
function scopeFile(target: Target): string {
  return target.scope === "global"
    ? getMCPConfigPath("user")
    : getMCPConfigPath("project", target.cwd ?? target.home ?? "");
}

/** The file a write goes to, or the sentence that refuses it. */
function writableFile(target: Target): { readonly file: string } | { readonly error: string } {
  if (target.scope === "project" && target.projectUnavailable !== undefined) {
    return { error: HOME_MESSAGE };
  }
  return { file: scopeFile(target) };
}

/**
 * Whether a new session starts project servers: `mcp.enableProjectConfig`, default true; the
 * project's own value wins over the global one (`mcp/config.ts:134` [V]). Read from the YAML
 * files, so it works without opening `agent.db`.
 */
async function projectConfigEnabled(cwd: string | undefined): Promise<boolean> {
  const path = ["mcp", "enableProjectConfig"];
  const project = cwd === undefined ? null : await readProjectLayer(cwd);
  const own = project === null || "error" in project ? undefined : getByPath(project.layer, path);
  if (typeof own === "boolean") return own;
  const global = await readLayer(await globalConfigFile());
  const value = "error" in global ? undefined : getByPath(global.layer, path);
  return typeof value === "boolean" ? value : true;
}

const nameOf = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("name must be a string");
  return value;
};

const isRaw = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Servers of one scope, in the file's order, with the enabled state omp's loader gives them. */
async function listScope(target: Target): Promise<McpListing> {
  const file = scopeFile(target);
  const own = await readMcpFile(file);
  if ("error" in own) return { scope: target.scope, file, servers: [], error: own.error };
  // The denylist and allowlist live in the user file whatever the scope; omp ignores a user
  // file it cannot read (`mcp/config.ts:118-123` [V]).
  const userPath = getMCPConfigPath("user");
  const user = target.scope === "global" ? own : await readMcpFile(userPath);
  const lists = "config" in user ? user.config : {};
  const servers = Object.entries(own.config.mcpServers ?? {}).map(([name, config]) =>
    toEntry(
      name,
      isRaw(config) ? config : {},
      isRaw(config) ? isEnabled(name, config, lists) : false,
    ),
  );
  const listing: McpListing = { scope: target.scope, file, servers };
  if (target.scope !== "project") return listing;
  const locked = target.projectUnavailable === undefined ? {} : { locked: HOME_MESSAGE };
  const inactive = (await projectConfigEnabled(target.cwd))
    ? {}
    : { inactive: PROJECT_OFF_MESSAGE };
  return { ...listing, ...locked, ...inactive };
}

/**
 * Handlers for `mcp.*`. Every write calls omp's own `config-writer.ts` (`addMCPServer`,
 * `updateMCPServer`, `removeMCPServer`, `setMcpServerEnabled` [V]): omp validates, takes its lock
 * on the file, and writes the bytes the CLI writes. Nothing here edits JSON by hand. A running
 * session is never touched: omp reads these files when a session starts (`session/new` carries
 * the servers), and this hosting mode has no watcher.
 */
export function mcpHandlers(
  control: SettingsControl,
): Pick<Required<Handlers>, (typeof MCP_CAPABILITIES)[number]> {
  let queue: Promise<unknown> = Promise.resolve();
  /** Writes run one at a time, so the listing a write returns is the file it just wrote. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const write = (
    params: SettingsTarget,
    name: string,
    work: (
      file: string,
      config: Record<string, unknown>,
    ) => Promise<{ message: string; field?: never } | null>,
  ): Promise<McpChange> =>
    serial(async () => {
      const target = await parseTarget(control, params);
      const where = writableFile(target);
      if ("error" in where) return { ok: false, message: where.error };
      const current = await readMcpFile(where.file);
      if ("error" in current) return { ok: false, message: current.error };
      try {
        const refused = await work(where.file, current.config as Record<string, unknown>);
        if (refused !== null) return { ok: false, message: refused.message };
      } catch (error) {
        return { ok: false, ...describeWriteError(error, name) };
      }
      return { ok: true, listing: await listScope(target) };
    });

  const save = (params: SettingsTarget & { readonly server: McpServerInput }, adding: boolean) => {
    assertServerInput(params.server);
    const input = params.server;
    const name = input.name.trim();
    return serial(async (): Promise<McpChange> => {
      const target = await parseTarget(control, params);
      const where = writableFile(target);
      if ("error" in where) return { ok: false, message: where.error };
      // Read before omp's writer takes its lock: an outside write to this very server in between
      // is overwritten by the merge below. The writer itself re-reads the file under the lock, so
      // every other server is safe; `addMCPServer` refuses a name that appeared meanwhile.
      const current = await readMcpFile(where.file);
      if ("error" in current) return { ok: false, message: current.error };
      const servers = current.config.mcpServers ?? {};
      const exists = Object.hasOwn(servers, name);
      const stored = exists ? servers[name] : undefined;
      if (adding && exists) {
        return { ok: false, ...describeWriteError(new Error(" already exists in "), name) };
      }
      if (!adding && !exists) {
        return { ok: false, ...describeWriteError(new Error(" not found in "), name) };
      }
      const built = buildConfig(
        input,
        adding ? undefined : (stored as unknown as Record<string, unknown>),
      );
      if (!("config" in built)) return { ok: false, ...built };
      try {
        if (adding) await addMCPServer(where.file, name, built.config);
        else await updateMCPServer(where.file, name, built.config);
      } catch (error) {
        return { ok: false, ...describeWriteError(error, name) };
      }
      return { ok: true, listing: await listScope(target) };
    });
  };

  return {
    "mcp.list": async (params) => listScope(await parseTarget(control, params)),

    "mcp.add": (params) => save(params, true),
    "mcp.update": (params) => save(params, false),

    "mcp.remove": (params) => {
      const name = nameOf(params.name);
      return write(params, name, async (file, config) => {
        // omp takes its lock, and so creates the directory and a lock file, before it looks for
        // the name: a missing server must be refused before that.
        const servers = config.mcpServers;
        if (!isRaw(servers) || !Object.hasOwn(servers, name)) {
          return { message: `There is no server named “${name}” in this scope.` };
        }
        await removeMCPServer(file, name);
        return null;
      });
    },

    "mcp.setEnabled": (params) => {
      const name = nameOf(params.name);
      if (typeof params.enabled !== "boolean") throw new Error("enabled must be a boolean");
      const { enabled } = params;
      return write(params, name, async (file, config) => {
        const servers = config.mcpServers;
        if (!isRaw(servers) || !Object.hasOwn(servers, name)) {
          return { message: `There is no server named “${name}” in this scope.` };
        }
        // `sourcePath` is the scope's own file and holds the entry, so omp writes `enabled` there
        // and tidies the user lists the way the extension dashboard does
        // (`dashboard-runtime.ts:41` [V]). The entry of the other scope is left alone, but a
        // project toggle can still rewrite the user file: it clears the name from the user
        // `disabledServers` or `enabledServers` list (`config-writer.ts:333-379` [V]).
        await setMcpServerEnabled({
          userPath: getMCPConfigPath("user"),
          projectPath: file,
          sourcePath: file,
          name,
          enabled,
        });
        return null;
      });
    },

    "mcp.reveal": async (params) => {
      const target = await parseTarget(control, params);
      const name = nameOf(params.name);
      const secret = params.secret as McpSecretRef;
      const current = await readMcpFile(scopeFile(target));
      if ("error" in current) throw new Error(current.error);
      const servers = current.config.mcpServers ?? {};
      if (!Object.hasOwn(servers, name)) throw new Error(`no server named ${name}`);
      const entry = servers[name] as unknown as Record<string, unknown>;
      let value: unknown;
      if (secret?.kind === "url") value = entry.url;
      else if (secret?.kind === "env" || secret?.kind === "header") {
        if (typeof secret.key !== "string") throw new Error("secret.key must be a string");
        const map = secret.kind === "env" ? entry.env : entry.headers;
        value = isRaw(map) && Object.hasOwn(map, secret.key) ? map[secret.key] : undefined;
      } else throw new Error("unknown secret kind");
      if (typeof value !== "string") throw new Error("no such stored value");
      return { value };
    },
  };
}

const PLUGIN_PROVIDERS: Record<string, true> = {
  "claude-plugins": true,
  "omp-plugins": true,
  "agent-plugins": true,
  skillshare: true,
};

function originOf(provider: string, level: string): SkillOrigin {
  if (Object.hasOwn(PLUGIN_PROVIDERS, provider)) return "plugin";
  return level === "project" ? "project" : "user";
}

/** Why omp is not loading a skill, as the extension dashboard names it (`state-manager.ts:49-62` [V]). */
const REASONS = {
  "provider-disabled": "Its source is switched off in omp’s settings.",
  "user-opt-in":
    "Skills from this tool’s folder in your home directory are off until you turn that source on.",
  "item-disabled": "You turned it off.",
  shadowed: "Another skill with the same name takes its place.",
} as const;

/**
 * The effective `disabledExtensions`: a project's own list replaces the global one, as any
 * array setting does when merged (`settings-catalog.ts` `readEffective`). Read from the files,
 * so listing works without opening `agent.db`.
 */
async function disabledList(cwd: string | undefined): Promise<{
  readonly ids: readonly string[];
  readonly projectOwned: boolean;
  readonly error?: string;
}> {
  const global = await readLayer(await globalConfigFile());
  if ("error" in global) return { ids: [], projectOwned: false, error: global.error };
  const project = cwd === undefined || cwd === homedir() ? null : await readProjectLayer(cwd);
  if (project !== null && "error" in project) {
    return { ids: [], projectOwned: false, error: project.error };
  }
  const own = project === null ? undefined : getByPath(project.layer, ["disabledExtensions"]);
  const raw = Array.isArray(own) ? own : getByPath(global.layer, ["disabledExtensions"]);
  return {
    ids: Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [],
    projectOwned: Array.isArray(own),
  };
}

async function sessionDir(
  control: SettingsControl,
  sessionId: unknown,
): Promise<string | undefined> {
  if (sessionId === undefined) return undefined;
  if (typeof sessionId !== "string") throw new Error("sessionId must be a string");
  const cwd = control.sessionCwd(sessionId);
  if (cwd === undefined) return undefined;
  return (await stat(cwd).catch(() => null))?.isDirectory() === true ? cwd : undefined;
}

/**
 * Skills as omp's extension dashboard lists them (`loadAllExtensions`, the same call, with the
 * effective `disabledExtensions` passed explicitly), including the ones that are off.
 */
async function listSkills(cwd: string | undefined): Promise<SkillsListing> {
  const disabled = await disabledList(cwd);
  if (disabled.error !== undefined) return { skills: [], error: disabled.error };
  const extensions = await loadAllExtensions(cwd ?? homedir(), [...disabled.ids]);
  const skills: SkillEntry[] = extensions
    .filter((e) => e.kind === "skill")
    .map((e): SkillEntry => {
      const reason = e.disabledReason === undefined ? undefined : REASONS[e.disabledReason];
      return {
        name: e.name,
        ...(e.description === undefined ? {} : { description: e.description }),
        origin: originOf(e.source.provider, e.source.level),
        provider: e.source.providerName,
        state: e.state,
        ...(reason === undefined ? {} : { reason }),
        // Only the per-skill switch is ours to flip; a switched-off source or a shadowed copy is not.
        toggleable: e.state === "active" || e.disabledReason === "item-disabled",
      };
    });
  return { skills };
}

/**
 * Handlers for `skills.*`. The switch is omp's own: the `skill:<name>` id in the
 * `disabledExtensions` setting, which the extension dashboard writes
 * (`dashboard-runtime.ts:23`, `state-manager.ts` [V]) and `createAgentSession` reads when a
 * session starts (`sdk.ts:1921` [V]). It is written on the shared global `Settings` and flushed.
 * Open sessions are not reloaded, so the change is for new sessions only.
 */
export function skillsHandlers(
  control: SettingsControl,
): Pick<Required<Handlers>, (typeof SKILLS_CAPABILITIES)[number]> {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    "skills.list": async (params) => listSkills(await sessionDir(control, params.sessionId)),

    "skills.setEnabled": (params) => {
      const name = nameOf(params.name);
      if (typeof params.enabled !== "boolean") throw new Error("enabled must be a boolean");
      const { enabled } = params;
      return serial(async (): Promise<SkillsChange> => {
        const cwd = await sessionDir(control, params.sessionId);
        const before = await disabledList(cwd);
        if (before.error !== undefined) return { ok: false, message: before.error };
        if (before.projectOwned) {
          return {
            ok: false,
            message:
              "This project sets its own list of disabled skills in .omp/config.yml. Change it there.",
          };
        }
        const listing = await listSkills(cwd);
        const skill = listing.skills.find((s) => s.name === name);
        if (skill === undefined)
          return { ok: false, message: `There is no skill named “${name}”.` };
        if (!skill.toggleable) {
          return { ok: false, message: skill.reason ?? "This skill can’t be switched here." };
        }
        const id = `skill:${name}`;
        const next = enabled
          ? before.ids.filter((x) => x !== id)
          : before.ids.includes(id)
            ? [...before.ids]
            : [...before.ids, id];
        const global = await control.globalSettings();
        // The shared instance read the file at start; take what is on disk now, then write.
        await global.reloadFromDisk();
        cfgDisabledExtensions.set(global, next);
        await global.flush();
        return { ok: true, listing: await listSkills(cwd) };
      });
    },
  };
}

export type { Capability };
