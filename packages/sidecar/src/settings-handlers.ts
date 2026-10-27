import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { type AnySetting, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
  SettingEntry,
  SettingScope,
  SettingsChange,
  SettingsListing,
  SettingsTarget,
} from "@omp-app/protocol";
import type { OmpHost } from "./omp-host";
import type { Handlers } from "./server";
import type { SessionStore } from "./session-store";
import {
  buildEntries,
  getByPath,
  loadRuntimeOptions,
  type RawLayer,
  type RuntimeOptions,
  settingsTabs,
} from "./settings-catalog";
import {
  deleteByPath,
  editProjectConfig,
  globalConfigFile,
  projectConfigFile,
  readLayer,
  readProjectLayer,
  setByPath,
} from "./settings-files";

/** What the handlers need from the omp host. Narrow, so tests can stand in for omp. */
export interface SettingsControl {
  /** The global `Settings` every session clones; opening it touches `agent.db`. */
  globalSettings(): Promise<Settings>;
  /** Each session's own clone: `cloneForCwd` copies the global layer, so it must be reloaded. */
  liveSessionSettings(): readonly Settings[];
  /** The project directory of an open session; `undefined` for an id the host does not know. */
  sessionCwd(sessionId: string): string | undefined;
}

/** The host supplies the settings objects; the store knows where each session runs. */
export function settingsControl(
  host: Pick<OmpHost, "globalSettings" | "liveSessionSettings">,
  store: Pick<SessionStore, "has" | "snapshot">,
): SettingsControl {
  return {
    globalSettings: () => host.globalSettings(),
    liveSessionSettings: () => host.liveSessionSettings(),
    sessionCwd: (id) => (store.has(id) ? store.snapshot(id).snapshot.cwd : undefined),
  };
}

export const SETTINGS_CAPABILITIES = [
  "settings.list",
  "settings.set",
  "settings.reset",
  "settings.reveal",
] as const;

interface Target {
  readonly scope: SettingScope;
  readonly cwd?: string;
  /** The session runs where omp reads no project config: the scope lists but cannot be edited. */
  readonly projectUnavailable?: string;
}

const HOME_MESSAGE =
  "This session runs in your home directory, where omp reads no project settings.";

/** omp reads no project config in the home directory (`discovery/builtin.ts:64-67` [V]). */
function isHome(dir: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(dir) === real(homedir());
}

/**
 * Checks the target at the trust boundary. The project directory is never taken from the
 * caller: it is the cwd of the session the caller names. A global listing tolerates a project
 * that is gone (the layer is just absent); a project one cannot work without it. The home
 * directory lists, with the project layer reported unavailable, because omp ignores a project
 * config there (`discovery/builtin.ts:64-67` [V]).
 */
async function parseTarget(control: SettingsControl, params: SettingsTarget): Promise<Target> {
  const { scope, sessionId } = params;
  if (scope !== "global" && scope !== "project") throw new Error(`unknown scope: ${String(scope)}`);
  if (sessionId === undefined) {
    if (scope === "project") throw new Error("the project scope needs a session");
    return { scope };
  }
  if (typeof sessionId !== "string") throw new Error("sessionId must be a string");
  const cwd = control.sessionCwd(sessionId);
  if (cwd === undefined) {
    if (scope === "project") throw new Error(`unknown session: ${sessionId}`);
    return { scope };
  }
  if (isHome(cwd)) return { scope, projectUnavailable: HOME_MESSAGE };
  const isDirectory = (await stat(cwd).catch(() => null))?.isDirectory() === true;
  if (isDirectory) return { scope, cwd };
  if (scope === "project") throw new Error(`project directory not found: ${cwd}`);
  return { scope };
}

function listedSetting(id: unknown): AnySetting {
  const setting = typeof id === "string" ? lookup(id) : undefined;
  if (setting?.ui === undefined) throw new Error(`unknown setting: ${String(id)}`);
  return setting;
}

/** Same checks omp runs before a write, in the same order; returns the message of the first failure. */
function refusal(setting: AnySetting, value: unknown): string | null {
  try {
    setting.assertWritable(setting.definition.normalize?.(value) ?? value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Handlers for `settings.*`.
 *
 * Reading never touches `agent.db`: both config files are parsed directly, so the screen works
 * in `read_only` mode and before any session exists. The global scope writes through omp's
 * `Setting.set` on the shared `Settings` instance (omp validates, normalizes and saves under its
 * file lock). omp's Settings API has no write for the project layer, so that scope edits
 * `.omp/config.yml` under the same lock (`settings-files.ts`).
 *
 * Nothing watches the files in this hosting mode (omp starts its watcher only in its own
 * rpc/interactive modes, `main.ts:2654` [V]), so after every write each session's settings are
 * reloaded from disk; a running session sees the change on its next read [V: test].
 */
export function settingsHandlers(
  control: SettingsControl,
): Pick<Required<Handlers>, (typeof SETTINGS_CAPABILITIES)[number]> {
  let runtime: RuntimeOptions | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  /** Writes run one at a time: each is read, edit, save, reload. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const read = async (target: Target, refresh: boolean): Promise<SettingsListing> => {
    if (refresh || runtime === undefined) runtime = await loadRuntimeOptions();
    const globalFile = await globalConfigFile();
    const global = await readLayer(globalFile);
    if ("error" in global) throw new Error(global.error);
    let project: RawLayer | null = null;
    let projectError: string | undefined = target.projectUnavailable;
    const projectFile =
      target.cwd === undefined || target.projectUnavailable !== undefined
        ? null
        : projectConfigFile(target.cwd);
    if (projectFile !== null) {
      const layer = await readProjectLayer(target.cwd ?? "");
      if ("error" in layer) projectError = layer.error;
      else project = layer.layer;
    }
    return {
      scope: target.scope,
      tabs: settingsTabs(),
      entries: buildEntries({ global: global.layer, project }, target.scope, runtime),
      files: { global: globalFile, project: projectFile },
      ...(projectError === undefined ? {} : { projectError }),
    };
  };

  /** Returns how many sessions kept their previous values because their reload failed. */
  const reloadSessions = async (): Promise<number> => {
    let failed = 0;
    for (const settings of control.liveSessionSettings()) {
      try {
        await settings.reloadFromDisk();
      } catch (error) {
        // The file is written; this session keeps its previous values until the next reload.
        failed++;
        console.error(
          `[sidecar] settings reload failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return failed;
  };

  /** The shared `Settings` holds the file as it read it at start: take what is on disk now. */
  const freshGlobal = async (): Promise<Settings> => {
    const global = await control.globalSettings();
    await global.reloadFromDisk();
    return global;
  };

  /** The edited entry plus every entry whose value or availability changed with it. */
  const change = async (
    target: Target,
    id: string,
    write: (before: SettingsListing) => Promise<string | null>,
  ): Promise<SettingsChange> =>
    serial(async () => {
      const before = await read(target, false);
      if (target.scope === "project" && before.projectError !== undefined) {
        return { ok: false, message: before.projectError };
      }
      const message = await write(before);
      if (message !== null) return { ok: false, message };
      const reloadFailed = await reloadSessions();
      const after = await read(target, false);
      const entries: SettingEntry[] = after.entries.filter(
        (entry, index) =>
          entry.id === id || JSON.stringify(entry) !== JSON.stringify(before.entries[index]),
      );
      return reloadFailed === 0 ? { ok: true, entries } : { ok: true, entries, reloadFailed };
    });

  const layerOfScope = async (target: Target): Promise<RawLayer> => {
    if (target.projectUnavailable !== undefined && target.scope === "project") {
      throw new Error(target.projectUnavailable);
    }
    const file =
      target.scope === "global" ? await globalConfigFile() : projectConfigFile(target.cwd ?? "");
    const layer = await readLayer(file);
    if ("error" in layer) throw new Error(layer.error);
    return layer.layer;
  };

  return {
    "settings.list": async (params) => read(await parseTarget(control, params), true),

    "settings.set": async (params) => {
      const target = await parseTarget(control, params);
      const setting = listedSetting(params.id);
      return change(target, setting.id, async () => {
        const message = refusal(setting, params.value);
        if (message !== null) return message;
        if (target.scope === "global") {
          const global = await freshGlobal();
          setting.set(global, params.value);
          await global.flush();
        } else {
          const value = setting.definition.normalize?.(params.value) ?? params.value;
          await editProjectConfig(target.cwd ?? "", (layer) =>
            setByPath(layer, setting.segments, value),
          );
        }
        return null;
      });
    },

    "settings.reset": async (params) => {
      const target = await parseTarget(control, params);
      const setting = listedSetting(params.id);
      return change(target, setting.id, async () => {
        if (target.scope === "global") {
          const global = await freshGlobal();
          setting.unset(global);
          await global.flush();
        } else {
          await editProjectConfig(target.cwd ?? "", (layer) =>
            deleteByPath(layer, setting.segments),
          );
        }
        return null;
      });
    },

    "settings.reveal": async (params) => {
      const target = await parseTarget(control, params);
      const setting = listedSetting(params.id);
      if (!setting.isCredential) throw new Error(`${setting.id} is not a secret`);
      const stored = getByPath(await layerOfScope(target), setting.segments);
      return { value: typeof stored === "string" ? stored : "" };
    },
  };
}
