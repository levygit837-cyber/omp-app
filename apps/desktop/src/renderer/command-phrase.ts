import type { CommandItem, ToolStatus } from "@omp-app/protocol";
import type { EnginePhase } from "./composer-state";
import { formatDuration, type Phrase } from "./tool-phrases";

/** The line as the person typed it, one line, cut for the row. The full text stays in the item. */
export function commandLabel(text: string): string {
  const line = text.split("\n", 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * A command that is still running on an engine that is gone was cut short: it will never finish.
 * (Unlike a tool it does not depend on a turn: a command runs while the session is idle.)
 */
export function shownCommandState(state: ToolStatus, engine: EnginePhase): ToolStatus {
  return state === "running" && engine !== "ready" ? "stopped" : state;
}

/**
 * The sentence of a command line, in the voice of the tool lines: what it is doing, what it did,
 * what stopped it. The command text is code. Facts after the dot are quiet.
 */
export function commandPhrase(item: CommandItem, state: ToolStatus): Phrase {
  const label = { text: commandLabel(item.text), mono: true } as const;
  const took =
    item.endedAt !== undefined && item.endedAt - item.startedAt >= 1000
      ? [[{ text: formatDuration(item.endedAt - item.startedAt) }]]
      : [];
  switch (state) {
    case "running":
      return { primary: [{ text: "Running " }, label, { text: "…" }], secondary: [] };
    case "failed":
      return { primary: [{ text: "Couldn’t run " }, label], secondary: took };
    case "stopped":
      return { primary: [{ text: "Stopped " }, label], secondary: [] };
    case "done":
      return { primary: [{ text: "Ran " }, label], secondary: took };
  }
}

/** What a screen reader hears when a command ends: the phrase, and why it failed. */
export function commandAnnouncement(item: CommandItem): string {
  const phrase = commandPhrase(item, item.state)
    .primary.map((part) => part.text)
    .join("");
  const firstLine = item.output.split("\n", 1)[0]?.trim() ?? "";
  if (item.state === "failed" && firstLine !== "") return `${phrase}: ${firstLine}`;
  return item.state === "done" && item.output !== ""
    ? `${phrase}. The output is in the timeline`
    : phrase;
}
