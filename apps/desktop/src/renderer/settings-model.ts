import type { SettingEntry, SettingScope, SettingSource, SettingsListing } from "@omp-app/protocol";

/** One heading of the screen: the settings of a tab that share a section. */
export interface Section {
  readonly tab: string;
  readonly group: string | null;
  readonly entries: readonly SettingEntry[];
}

/**
 * Splits entries into sections, in the order the listing carries them (tab, then the registry's
 * section order). Entries of one section are contiguous in a listing, but a Map keeps this
 * correct for any input order.
 */
export function sectionsOf(entries: readonly SettingEntry[]): Section[] {
  const sections = new Map<
    string,
    { tab: string; group: string | null; entries: SettingEntry[] }
  >();
  for (const entry of entries) {
    const key = `${entry.tab}\u0000${entry.group ?? ""}`;
    const section = sections.get(key);
    if (section) section.entries.push(entry);
    else sections.set(key, { tab: entry.tab, group: entry.group, entries: [entry] });
  }
  return [...sections.values()];
}

/** An entry is "changed" in a scope when that scope's file sets it. */
export function isChanged(entry: SettingEntry, scope: SettingScope): boolean {
  return entry.layers[scope].set;
}

export function changedByTab(
  entries: readonly SettingEntry[],
  scope: SettingScope,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (isChanged(entry, scope)) counts[entry.tab] = (counts[entry.tab] ?? 0) + 1;
  }
  return counts;
}

function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Entries whose label, description or key contain every word of `query`. Empty query: none. */
export function searchEntries(entries: readonly SettingEntry[], query: string): SettingEntry[] {
  const words = terms(query);
  if (words.length === 0) return [];
  return entries.filter((entry) => {
    const text = `${entry.label}\n${entry.description}\n${entry.id}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** True when a result matched through its key only, which the screen says out loud. */
export function matchedByKeyOnly(entry: SettingEntry, query: string): boolean {
  const text = `${entry.label}\n${entry.description}`.toLowerCase();
  return terms(query).some((word) => !text.includes(word));
}

export function tabCounts(entries: readonly SettingEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.tab] = (counts[entry.tab] ?? 0) + 1;
  return counts;
}

/** Replaces, by id, the entries a write reported as changed. */
export function mergeEntries(
  listing: SettingsListing,
  changed: readonly SettingEntry[],
): SettingsListing {
  const byId = new Map(changed.map((entry) => [entry.id, entry]));
  return { ...listing, entries: listing.entries.map((entry) => byId.get(entry.id) ?? entry) };
}

const CLIP = 48;

/** A value as a person reads it: option labels, units, On/Off. Never used for secrets. */
export function formatValue(entry: SettingEntry, value: unknown): string {
  if (value === undefined || value === null) return "not set";
  const clip = (text: string) => (text.length > CLIP ? `${text.slice(0, CLIP - 1)}…` : text);
  const labels = new Map((entry.options ?? []).map((option) => [option.value, option.label]));
  if (Array.isArray(value)) {
    if (value.length === 0) return "empty list";
    const shown = value.map((item) =>
      typeof item === "string" ? (labels.get(item) ?? item) : JSON.stringify(item),
    );
    return clip(shown.join(", "));
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    const preset = labels.get(String(value));
    if (preset !== undefined) return preset;
    return entry.unit ? `${value} ${entry.unit}` : String(value);
  }
  if (typeof value === "string") return value === "" ? "empty" : clip(labels.get(value) ?? value);
  return clip(JSON.stringify(value));
}

export const SOURCE_LABEL: Record<SettingSource, string> = {
  default: "Default",
  global: "Global",
  project: "Project",
};

/** One line of the "Effective value" popover. */
export interface ChainRow {
  readonly source: SettingSource;
  /** The config file, or "omp registry" for the default. */
  readonly where: string;
  readonly value: string;
  readonly isSet: boolean;
  /** This layer is the one whose value applies. */
  readonly effective: boolean;
}

/** `~` for the home directory, so long paths stay short. Heuristic: macOS and Linux homes. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/** The layers that decide the value in `scope`, highest priority first. */
export function effectiveChain(
  entry: SettingEntry,
  files: SettingsListing["files"],
  scope: SettingScope,
): ChainRow[] {
  const stored = (layer: SettingEntry["layers"]["global"]): { isSet: boolean; value: string } =>
    layer.set
      ? { isSet: true, value: entry.secret ? "set" : formatValue(entry, layer.value) }
      : { isSet: false, value: "not set" };
  const rows: ChainRow[] = [];
  if (scope === "project") {
    rows.push({
      source: "project",
      where: files.project ? shortPath(files.project) : "no project",
      ...stored(entry.layers.project),
      effective: entry.source === "project",
    });
  }
  rows.push({
    source: "global",
    where: shortPath(files.global),
    ...stored(entry.layers.global),
    effective: entry.source === "global",
  });
  rows.push({
    source: "default",
    where: "omp registry",
    isSet: true,
    value: entry.secret ? "none" : formatValue(entry, entry.layers.default),
    effective: entry.source === "default",
  });
  return rows;
}

/** What "Reset" falls back to in `scope`, for its label. */
export function resetTarget(entry: SettingEntry, scope: SettingScope): "Global" | "default" {
  return scope === "project" && entry.layers.global.set ? "Global" : "default";
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export function parseNumberInput(text: string): Parsed<number> {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(value)) return { ok: false, message: "Enter a number." };
  return { ok: true, value };
}

export function parseJsonInput(text: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: "Not valid JSON." };
  }
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}
