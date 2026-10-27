import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { invalidate as invalidateCapabilityFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { replaceFileAtomically } from "@oh-my-pi/pi-coding-agent/utils/atomic-file";
import {
  getAgentDir,
  getProjectAgentDir,
  isEnoent,
  MAIN_CONFIG_FILENAMES,
} from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { stringifyYamlConfig } from "@oh-my-pi/pi-utils/yaml-config";
import { YAML } from "bun";
import type { RawLayer } from "./settings-catalog";

/**
 * Reads and edits the two YAML files omp settings live in. The global file is written by omp's
 * own `Settings` instance (see `settings-handlers.ts`). omp has no API that writes a setting
 * into a project's `.omp/config.yml` (its only project write is `#saveProjectNow`, which
 * handles model roles alone, `config/settings.ts:3856` [V]), so this module repeats that
 * method's sequence for any setting: create `.omp`, take omp's file lock, read, edit, write
 * through a temp file and rename, drop the capability cache [V].
 */

export type LayerRead = { readonly layer: RawLayer } | { readonly error: string };

/** A missing or empty file is an empty layer. A file that does not parse is an error, never fixed. */
export async function readLayer(file: string): Promise<LayerRead> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isEnoent(error)) return { layer: {} };
    throw error;
  }
  try {
    const parsed: unknown = YAML.parse(text);
    if (parsed === null || parsed === undefined) return { layer: {} };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: `${file} must hold a mapping at the top level.` };
    }
    return { layer: parsed as RawLayer };
  } catch (error) {
    return {
      error: `${file} is not valid YAML: ${error instanceof Error ? error.message : error}`,
    };
  }
}

/** The file omp reads for the global layer: `config.yml`, or `config.yaml` when only that exists. */
export async function globalConfigFile(): Promise<string> {
  const dir = getAgentDir();
  for (const name of MAIN_CONFIG_FILENAMES) {
    const file = join(dir, name);
    const found = await readFile(file).then(
      () => true,
      () => false,
    );
    if (found) return file;
  }
  return join(dir, MAIN_CONFIG_FILENAMES[0]);
}

export function projectConfigFile(cwd: string): string {
  return join(getProjectAgentDir(cwd), "config.yml");
}

/**
 * What omp applies from the project directory: `.omp/settings.json` first, `.omp/config.yml`
 * over it (`discovery/builtin.ts:896-917` pushes them in that order and the merge lets the
 * later item win [V]). Only `config.yml` is ever written. A `settings.json` that does not
 * parse is skipped, as omp skips it with a warning. `.claude/settings.json` comes from a
 * different provider and is not read here [S].
 */
export async function readProjectLayer(cwd: string): Promise<LayerRead> {
  const yml = await readLayer(projectConfigFile(cwd));
  if ("error" in yml) return yml;
  const legacy = await readFile(join(getProjectAgentDir(cwd), "settings.json"), "utf8").then(
    (text) => {
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as RawLayer)
          : {};
      } catch {
        return {};
      }
    },
    () => ({}),
  );
  return { layer: mergeLayers(legacy, yml.layer) };
}

/** omp's `#deepMerge` (`config/settings.ts:3918` [V]): plain objects merge, anything else is replaced. */
export function mergeLayers(base: RawLayer, over: RawLayer): RawLayer {
  const result: RawLayer = {};
  for (const key of Object.keys(over)) {
    const value = over[key];
    if (value === undefined) continue;
    const below = Object.hasOwn(base, key) ? base[key] : undefined;
    result[key] = isPlain(value) && isPlain(below) ? mergeLayers(below, value) : value;
  }
  for (const key of Object.keys(base)) if (!Object.hasOwn(result, key)) result[key] = base[key];
  return result;
}

function isPlain(v: unknown): v is RawLayer {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Where a write must land when `file` is a symlink: omp follows it, so the link survives. */
async function resolveWritePath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if (isEnoent(error)) return file;
    throw error;
  }
}

async function writeAtomically(file: string, content: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let stray = false;
  try {
    const handle = await open(temp, "wx", 0o600);
    stray = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceFileAtomically(temp, file);
    stray = false;
  } finally {
    if (stray) await rm(temp, { force: true }).catch(() => {});
  }
}

export function setByPath(layer: RawLayer, segments: readonly string[], value: unknown): void {
  let current = layer;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) current[segment] = {};
    current = current[segment] as RawLayer;
  }
  current[segments[segments.length - 1] as string] = value;
}

/** Removes the key and the parent objects that the removal leaves empty, like omp's own. */
export function deleteByPath(layer: RawLayer, segments: readonly string[]): void {
  const chain: RawLayer[] = [layer];
  for (const segment of segments.slice(0, -1)) {
    const next = chain[chain.length - 1]?.[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) return;
    chain.push(next as RawLayer);
  }
  delete chain[chain.length - 1]?.[segments[segments.length - 1] as string];
  for (let i = chain.length - 1; i > 0; i--) {
    const node = chain[i] as RawLayer;
    if (Object.keys(node).length > 0) break;
    delete (chain[i - 1] as RawLayer)[segments[i - 1] as string];
  }
}

/**
 * Edits the project's `.omp/config.yml` under omp's lock on that file. A file that does not
 * parse is left alone and the edit fails: omp moves such a file aside, and an app that edits
 * settings should never be the one to do it. Writes nothing when the edit changes nothing.
 */
export async function editProjectConfig(
  cwd: string,
  edit: (layer: RawLayer) => void,
): Promise<void> {
  const file = projectConfigFile(cwd);
  // Look before creating anything: an edit that changes nothing (a reset of a key the file
  // never had) must not leave a `.omp/` directory or a lock file in the project.
  const current = await readLayer(file);
  if ("error" in current) throw new Error(current.error);
  const probe = structuredClone(current.layer);
  edit(probe);
  if (JSON.stringify(probe) === JSON.stringify(current.layer)) return;
  await mkdir(dirname(file), { recursive: true });
  const target = await resolveWritePath(file);
  await withFileLock(target, async () => {
    const read = await readLayer(target);
    if ("error" in read) throw new Error(read.error);
    const before = JSON.stringify(read.layer);
    edit(read.layer);
    if (JSON.stringify(read.layer) === before) return;
    await writeAtomically(target, stringifyYamlConfig(read.layer));
  });
  invalidateCapabilityFsCache(file);
}
