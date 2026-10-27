/**
 * Settings screen contract. The sidecar derives every entry from omp's settings registry
 * (`config/registry.ts`), so the app never hand-writes a setting. Secrets never appear in a
 * listing: `settings.reveal` hands out one value on demand.
 */

import { isRecord } from "./guards";

/** Which config file an edit targets: omp's global `config.yml` or the project's `.omp/config.yml`. */
export type SettingScope = "global" | "project";

export type SettingType = "boolean" | "string" | "number" | "enum" | "array" | "record";

/** Where the effective value in a scope comes from. */
export type SettingSource = "default" | "global" | "project";

export interface SettingOption {
  /** Always text; a number setting parses it back with `Number`. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** What one config file holds for a setting. A secret reports only whether it is set. */
export type SettingLayer =
  | { readonly set: false }
  | { readonly set: true; readonly value?: unknown };

export interface SettingEntry {
  /** Dotted registry id, as written in config files. */
  readonly id: string;
  /** Registry tab id (`SettingsTab.id`). */
  readonly tab: string;
  /** Section inside the tab; `null` for settings the registry leaves ungrouped. */
  readonly group: string | null;
  readonly label: string;
  readonly description: string;
  /** Risk note from the registry (rate limits, bans). */
  readonly warning?: string;
  readonly type: SettingType;
  /** Masked everywhere: `value` and the layer values are withheld. */
  readonly secret: boolean;
  /** Short unit for numbers, read from the id suffix (`Ms` gives `ms`). */
  readonly unit?: string;
  /** Closed choices: enum values, submenu presets, array membership, runtime lists (themes). */
  readonly options?: readonly SettingOption[];
  /** The value has no simple control: edit it as JSON text. */
  readonly json?: boolean;
  /** Array whose entry order matters (the editor shows positions and lets entries move). */
  readonly ordered?: boolean;
  /** Environment variable that overrides this setting while it is set. */
  readonly envName?: string;
  readonly envActive: boolean;
  /** Effective value in the listing's scope (`null` for a secret). */
  readonly value: unknown;
  readonly source: SettingSource;
  readonly layers: {
    readonly default: unknown;
    readonly global: SettingLayer;
    readonly project: SettingLayer;
  };
  /** Set when a `condition` of the registry is unmet: the control stays visible but disabled. */
  readonly disabledReason?: string;
}

export interface SettingsTab {
  readonly id: string;
  readonly label: string;
  readonly lead: string;
  /** Section order the registry defines for this tab. */
  readonly groups: readonly string[];
}

export interface SettingsListing {
  readonly scope: SettingScope;
  readonly tabs: readonly SettingsTab[];
  /** In registry order: tab, then section, then declaration. */
  readonly entries: readonly SettingEntry[];
  readonly files: {
    readonly global: string;
    /** `null` when the listing was asked without a project directory. */
    readonly project: string | null;
  };
  /** The project config exists but cannot be read; its values are left out and edits refused. */
  readonly projectError?: string;
}

/** Result of `settings.set` and `settings.reset`: a refused value is data, not an error. */
export type SettingsChange =
  | {
      readonly ok: true;
      /** The edited entry plus any whose value or availability changed with it. */
      readonly entries: readonly SettingEntry[];
      /**
       * Running sessions that could not reload their settings after the write. The file is
       * saved; those sessions keep their previous values. Absent when every session reloaded.
       */
      readonly reloadFailed?: number;
    }
  | { readonly ok: false; readonly message: string };

export interface SettingsRevealResult {
  readonly value: string;
}

const isString = (v: unknown): v is string => typeof v === "string";

function isLayer(v: unknown): v is SettingLayer {
  return isRecord(v) && typeof v.set === "boolean";
}

export function isSettingEntry(v: unknown): v is SettingEntry {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.tab) &&
    (v.group === null || isString(v.group)) &&
    isString(v.label) &&
    isString(v.description) &&
    isString(v.type) &&
    typeof v.secret === "boolean" &&
    typeof v.envActive === "boolean" &&
    (v.source === "default" || v.source === "global" || v.source === "project") &&
    isRecord(v.layers) &&
    isLayer(v.layers.global) &&
    isLayer(v.layers.project) &&
    (v.options === undefined || Array.isArray(v.options))
  );
}

function isSettingsTab(v: unknown): v is SettingsTab {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.label) &&
    isString(v.lead) &&
    Array.isArray(v.groups) &&
    v.groups.every(isString)
  );
}

export function isSettingsListing(v: unknown): v is SettingsListing {
  return (
    isRecord(v) &&
    (v.scope === "global" || v.scope === "project") &&
    Array.isArray(v.tabs) &&
    v.tabs.every(isSettingsTab) &&
    Array.isArray(v.entries) &&
    v.entries.every(isSettingEntry) &&
    isRecord(v.files) &&
    isString(v.files.global) &&
    (v.files.project === null || isString(v.files.project))
  );
}

export function isSettingsChange(v: unknown): v is SettingsChange {
  if (!isRecord(v)) return false;
  if (v.ok === true) {
    return (
      Array.isArray(v.entries) &&
      v.entries.every(isSettingEntry) &&
      (v.reloadFailed === undefined ||
        (typeof v.reloadFailed === "number" &&
          Number.isInteger(v.reloadFailed) &&
          v.reloadFailed > 0))
    );
  }
  return v.ok === false && isString(v.message);
}

export function isSettingsRevealResult(v: unknown): v is SettingsRevealResult {
  return isRecord(v) && isString(v.value);
}
