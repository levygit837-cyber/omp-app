import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import { type AnySetting, lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getComposerShapeOptions } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";
import {
  type AnyUiMetadata,
  SETTING_TABS,
  type SubmenuOption,
  TAB_GROUPS,
  TAB_LEADS,
  TAB_METADATA,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { getAvailableThemes } from "@oh-my-pi/pi-tui/theme";
import type {
  SettingEntry,
  SettingLayer,
  SettingOption,
  SettingScope,
  SettingSource,
  SettingsTab,
} from "@omp-app/protocol";
import { mergeLayers } from "./settings-files";

/** A parsed config file: nested objects keyed by the dotted registry id's segments. */
export type RawLayer = Record<string, unknown>;

export interface Layers {
  readonly global: RawLayer;
  /** `null` when the listing has no project, or the project's config is unreadable. */
  readonly project: RawLayer | null;
}

export function getByPath(layer: RawLayer, segments: readonly string[]): unknown {
  let current: unknown = layer;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Registry ids the app lists: every setting with `ui` metadata, the same set omp's own panel
 * walks (`config/settings-ui.ts`). Settings without `ui` stay config-file only [V].
 */
export function listedSettings(): readonly AnySetting[] {
  return orderedSettings().filter((s) => s.ui !== undefined);
}

/** Per-tab section order and lead line come from omp's tui package, not from this app [V]. */
export function settingsTabs(): SettingsTab[] {
  return SETTING_TABS.map((id) => ({
    id,
    label: TAB_METADATA[id].label,
    lead: TAB_LEADS[id],
    groups: TAB_GROUPS[id],
  }));
}

/** Arrays whose items are objects: no chips editor can hold them (`exec/settings.ts:145` [V]). */
const OBJECT_ARRAYS: Readonly<Record<string, true>> = { "bash.patterns": true };
/**
 * Records of plain strings. The registry has no field for the value type, so this is the one
 * record with string values [V: tools/settings.ts:295, policies are allow|prompt|deny]; every
 * other record (`providers.maxInFlightRequests`, `retry.fallbackChains`) edits as JSON.
 */
const KEY_VALUE_RECORDS: Readonly<Record<string, true>> = { "tools.approval": true };

const UNIT_SUFFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Ms$/, "ms"],
  [/(Seconds|Sec)$/, "s"],
  [/Minutes$/, "min"],
  [/Hours$/, "h"],
  [/(Pct|Percent)$/, "%"],
  [/Tokens$/, "tokens"],
  [/Bytes$/, "bytes"],
  [/Lines$/, "lines"],
  [/Columns$/, "columns"],
];

/** The registry has no unit field; the id suffix is the only hint [I]. */
function unitOf(id: string): string | undefined {
  const last = id.slice(id.lastIndexOf(".") + 1);
  return UNIT_SUFFIXES.find(([pattern]) => pattern.test(last))?.[1];
}

type Reader = (id: string) => { readonly value: unknown; readonly source: SettingSource };

/** What a condition may ask besides effective values: only the project file knows this one. */
interface ConditionContext {
  readonly scope: SettingScope;
  /** The project config sets the setting to something other than `null`. */
  readonly projectSets: (id: string) => boolean;
}

interface Condition {
  readonly met: (read: Reader, context: ConditionContext) => boolean;
  readonly reason: string;
}

const flag =
  (id: string): Condition["met"] =>
  (read) =>
    read(id).value === true;
const equals =
  (id: string, expected: string): Condition["met"] =>
  (read) =>
    read(id).value === expected;

/**
 * Conditions of omp's registry, evaluated over the listing's scope. omp keeps the same table
 * private in `config/settings-ui.ts:26` and evaluates it against the process-wide settings [V],
 * so it is mirrored here. The two terminal conditions cannot hold in this app, which renders
 * no terminal output.
 */
const CONDITIONS: Readonly<Record<string, Condition>> = {
  macOS: { met: () => process.platform === "darwin", reason: "Only applies on macOS." },
  hasImageProtocol: {
    met: () => false,
    reason: "Applies to terminals that show inline images. This app does not render a terminal.",
  },
  nativeRendering: {
    met: () => false,
    reason: "Applies to omp's native terminal renderer, which this app does not use.",
  },
  advisorEnabled: { met: flag("advisor.enabled"), reason: "Turn on the Advisor first." },
  vimModeEnabled: { met: flag("tui.vimMode"), reason: "Turn on Vim mode first." },
  hindsightActive: {
    met: equals("memory.backend", "hindsight"),
    reason: "Set the memory backend to Hindsight first.",
  },
  mnemopiActive: {
    met: equals("memory.backend", "mnemopi"),
    reason: "Set the memory backend to Mnemopi first.",
  },
  autolearnActive: { met: flag("autolearn.enabled"), reason: "Turn on Auto-Learn first." },
  autoThinkingActive: {
    met: equals("defaultThinkingLevel", "auto"),
    reason: "Set the thinking level to Auto first.",
  },
  usageAwareFallbackEnabled: {
    met: flag("retry.usageAwareFallback"),
    reason: "Turn on usage-aware fallback first.",
  },
  planModeEnabled: { met: flag("plan.enabled"), reason: "Turn on plan mode first." },
  planAutosaveEnabled: {
    met: (read) => read("plan.enabled").value === true && read("plan.autosave").value === true,
    reason: "Turn on plan mode and plan autosave first.",
  },
  // The editor of the global scope would otherwise copy a project-supplied list into the global
  // file. Editing the project scope itself is the way to change that list, so it stays open there.
  contextFilesExtraNotProject: {
    met: (_read, context) =>
      context.scope === "project" || !context.projectSets("contextFiles.extra"),
    reason: "The project config sets this list. Edit it in the project scope.",
  },
};

/** Values the registry only knows at runtime (installed themes, composer shapes). */
export interface RuntimeOptions {
  readonly themes: readonly string[];
  readonly composerShapes: readonly SubmenuOption[];
}

export async function loadRuntimeOptions(): Promise<RuntimeOptions> {
  return { themes: await getAvailableThemes(), composerShapes: getComposerShapeOptions() };
}

function toOption(o: SubmenuOption): SettingOption {
  return o.description === undefined
    ? { value: o.value, label: o.label }
    : { value: o.value, label: o.label, description: o.description };
}

function optionsOf(
  setting: AnySetting,
  ui: AnyUiMetadata,
  runtime: RuntimeOptions,
): SettingOption[] | undefined {
  if (ui.options === "runtime") {
    if (setting.id === "composer.shape") return runtime.composerShapes.map(toOption);
    return runtime.themes.map((name) => ({ value: name, label: name }));
  }
  if (ui.options) return ui.options.map(toOption);
  const values = setting.type === "enum" ? setting.enumValues : undefined;
  if (values) return values.map((v) => ({ value: v, label: v }));
  const items = setting.type === "array" ? setting.definition : undefined;
  if (items?.type === "array" && items.items) {
    return items.items.values.map((v) => ({ value: v, label: v }));
  }
  return undefined;
}

function layerOf(raw: RawLayer | null, setting: AnySetting, secret: boolean): SettingLayer {
  const value = raw === null ? undefined : getByPath(raw, setting.segments);
  if (value === undefined) return { set: false };
  return secret ? { set: true } : { set: true, value };
}

/**
 * The effective value for one setting in a scope, merged the way omp merges its layers
 * (`config/settings.ts:3918`, `:877-892` [V]): project over global, plain objects merge key by
 * key, anything else is replaced, and a value that merges to `null` is unset, so the default
 * applies. The global scope ignores the project file: it shows what the global file alone gives,
 * which is what a global edit changes.
 */
export function readEffective(
  layers: Layers,
  setting: AnySetting,
  scope: SettingScope,
): { readonly value: unknown; readonly source: SettingSource } {
  const project = scope === "project" ? layers.project : null;
  const merged = getByPath(
    project === null ? layers.global : mergeLayers(layers.global, project),
    setting.segments,
  );
  if (merged === undefined || merged === null) return { value: setting.default, source: "default" };
  if (project !== null && getByPath(project, setting.segments) !== undefined) {
    return { value: merged, source: "project" };
  }
  return { value: merged, source: "global" };
}

function disabledReasonOf(
  condition: string | undefined,
  read: Reader,
  context: ConditionContext,
): string | undefined {
  if (condition === undefined) return undefined;
  const rule = CONDITIONS[condition];
  if (rule === undefined || rule.met(read, context)) return undefined;
  return rule.reason;
}

export function buildEntries(
  layers: Layers,
  scope: SettingScope,
  runtime: RuntimeOptions,
): SettingEntry[] {
  const read: Reader = (id) => {
    const setting = lookup(id);
    return setting
      ? readEffective(layers, setting, scope)
      : { value: undefined, source: "default" };
  };
  const context: ConditionContext = {
    scope,
    projectSets: (id) => {
      const setting = lookup(id);
      if (setting === undefined || layers.project === null) return false;
      const value = getByPath(layers.project, setting.segments);
      return value !== undefined && value !== null;
    },
  };
  const entries: SettingEntry[] = [];
  for (const setting of listedSettings()) {
    const ui = setting.ui;
    if (ui === undefined) continue;
    const secret = setting.isCredential;
    const { value, source } = readEffective(layers, setting, scope);
    const options = optionsOf(setting, ui, runtime);
    const type = setting.type;
    const json =
      (type === "array" && (ui.editor === "json" || OBJECT_ARRAYS[setting.id] === true)) ||
      (type === "record" && KEY_VALUE_RECORDS[setting.id] !== true);
    const unit = type === "number" ? unitOf(setting.id) : undefined;
    const disabledReason = disabledReasonOf(ui.condition, read, context);
    entries.push({
      id: setting.id,
      tab: ui.tab,
      group: ui.group ?? null,
      label: ui.label,
      description: ui.description,
      ...(ui.warning ? { warning: ui.warning } : {}),
      type,
      secret,
      ...(unit ? { unit } : {}),
      ...(options ? { options } : {}),
      ...(json ? { json: true } : {}),
      ...(ui.ordered ? { ordered: true } : {}),
      ...(setting.envName ? { envName: setting.envName } : {}),
      envActive: setting.envName !== undefined && setting.envValue() !== undefined,
      value: secret ? null : (value ?? null),
      source,
      layers: {
        default: secret ? null : (setting.default ?? null),
        global: layerOf(layers.global, setting, secret),
        project: layerOf(layers.project, setting, secret),
      },
      ...(disabledReason ? { disabledReason } : {}),
    });
  }
  return rankEntries(entries);
}

/** Tab order, then the tab's section order (ungrouped first), then declaration order. */
function rankEntries(entries: SettingEntry[]): SettingEntry[] {
  const tabRank = new Map(SETTING_TABS.map((t, i) => [t as string, i]));
  const groupRank = (e: SettingEntry): number => {
    if (e.group === null) return -1;
    const order = (TAB_GROUPS as Record<string, readonly string[]>)[e.tab] ?? [];
    const i = order.indexOf(e.group);
    return i >= 0 ? i : order.length;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (tabRank.get(a.entry.tab) ?? 0) - (tabRank.get(b.entry.tab) ?? 0) ||
        groupRank(a.entry) - groupRank(b.entry) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);
}
