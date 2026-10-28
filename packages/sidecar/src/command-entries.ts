import { COMMAND_OUTPUT_MAX, type CommandItem, isTimelineItem } from "@omp-app/protocol";
import { isRecord } from "./tool-output";

/**
 * `customType` of the session-file entry that keeps a command's answer. A plain `custom` entry,
 * not a `custom_message`: omp never puts the former into the model's context, while a
 * `custom_message` becomes a `custom` message in `convertToLlm` (`session/messages.ts:1129` [V]),
 * so the model would read every `/usage` the person ran.
 */
export const COMMAND_ENTRY_TYPE = "omp-app/command";

/** What the entry carries: the finished `command` item minus its position. */
export type StoredCommand = Omit<CommandItem, "kind" | "id">;

export function storedCommandOf(item: CommandItem): StoredCommand {
  const { kind: _kind, id: _id, ...rest } = item;
  return rest;
}

/** Cuts `output` to the item's limit; the flag says whether anything was cut. */
export function clampOutput(output: string): { output: string; truncated: boolean } {
  if (output.length <= COMMAND_OUTPUT_MAX) return { output, truncated: false };
  // A cut between the two halves of a surrogate pair would leave a lone half, which is not text.
  const high = output.charCodeAt(COMMAND_OUTPUT_MAX - 1);
  const end = high >= 0xd800 && high <= 0xdbff ? COMMAND_OUTPUT_MAX - 1 : COMMAND_OUTPUT_MAX;
  return { output: output.slice(0, end), truncated: true };
}

/**
 * The commands saved on a session branch, oldest first. Entries of other writers, of another
 * shape or still running (the sidecar died before it finished) are skipped: nothing is invented.
 */
export function readStoredCommands(entries: readonly unknown[]): StoredCommand[] {
  const found: StoredCommand[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== COMMAND_ENTRY_TYPE)
      continue;
    const data = entry.data;
    if (!isRecord(data) || !isTimelineItem({ ...data, kind: "command", id: "stored" })) continue;
    if (data.state === "running") continue;
    found.push(data as unknown as StoredCommand);
  }
  return found;
}
