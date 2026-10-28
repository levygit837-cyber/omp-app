import { describe, expect, test } from "bun:test";
import type { CommandItem } from "@omp-app/protocol";
import {
  commandAnnouncement,
  commandLabel,
  commandPhrase,
  shownCommandState,
} from "../src/renderer/command-phrase";

const item = (over: Partial<CommandItem> = {}): CommandItem => ({
  kind: "command",
  id: "i0",
  text: "/usage",
  state: "done",
  output: "",
  startedAt: 1000,
  ...over,
});

const words = (p: ReturnType<typeof commandPhrase>) =>
  [
    p.primary.map((x) => x.text).join(""),
    ...p.secondary.map((f) => f.map((x) => x.text).join("")),
  ].join(" · ");

describe("commandPhrase", () => {
  test("says what the command is doing, did, or could not do", () => {
    expect(words(commandPhrase(item({ state: "running" }), "running"))).toBe("Running /usage…");
    expect(words(commandPhrase(item(), "done"))).toBe("Ran /usage");
    expect(words(commandPhrase(item({ state: "failed" }), "failed"))).toBe("Couldn’t run /usage");
    expect(words(commandPhrase(item({ state: "stopped" }), "stopped"))).toBe("Stopped /usage");
  });

  test("the command text is code, the verb is not", () => {
    const [verb, command] = commandPhrase(item(), "done").primary;
    expect(verb?.mono).toBeUndefined();
    expect(command?.mono).toBe(true);
  });

  test("a duration shows only once it is worth reading", () => {
    expect(words(commandPhrase(item({ endedAt: 1900 }), "done"))).toBe("Ran /usage");
    expect(words(commandPhrase(item({ endedAt: 4400 }), "done"))).toBe("Ran /usage · 3.4s");
  });

  test("the label is one line and cut", () => {
    expect(commandLabel("/rename  a\nb")).toBe("/rename a");
    expect(commandLabel(`/x ${"y".repeat(100)}`).length).toBe(60);
  });
});

describe("shownCommandState", () => {
  test("a command still running on a dead engine was stopped, not left spinning", () => {
    expect(shownCommandState("running", "failed")).toBe("stopped");
    expect(shownCommandState("running", "restarting")).toBe("stopped");
    expect(shownCommandState("running", "ready")).toBe("running");
    expect(shownCommandState("done", "failed")).toBe("done");
  });
});

describe("commandAnnouncement", () => {
  test("a failure says why, in omp's first line; a success points at the output", () => {
    expect(
      commandAnnouncement(item({ state: "failed", output: "Cannot move while streaming.\nmore" })),
    ).toBe("Couldn’t run /usage: Cannot move while streaming.");
    expect(commandAnnouncement(item({ output: "Provider usage" }))).toBe(
      "Ran /usage. The output is in the timeline",
    );
    expect(commandAnnouncement(item({ state: "stopped" }))).toBe("Stopped /usage");
  });
});
