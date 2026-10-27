import { describe, expect, test } from "bun:test";
import type { Item, SessionSnapshot, ThinkingItem, ToolCall, ToolItem } from "@omp-app/protocol";
import {
  formatDuration,
  formatElapsed,
  type Phrase,
  shortReason,
  thinkingGist,
  tokensPerSecond,
  toolPhrase,
} from "../src/renderer/tool-phrases";

const golden = async (name: string): Promise<SessionSnapshot> =>
  (
    await Bun.file(
      `${import.meta.dir}/../../../packages/sidecar/test/fixtures/${name}.golden.json`,
    ).json()
  ).final;

const toolItems = async (name: string): Promise<ToolItem[]> =>
  (await golden(name)).snapshot.timeline.filter((i: Item): i is ToolItem => i.kind === "tool");

/** The sentence as plain text: primary, then each fact after a middle dot. */
const text = (p: Phrase): string =>
  [
    p.primary.map((x) => x.text).join(""),
    ...p.secondary.map((f) => f.map((x) => x.text).join("")),
  ].join(" · ");

const call = (patch: Partial<ToolCall> = {}): ToolCall => ({
  toolCallId: "c",
  status: "done",
  startedAt: 0,
  endedAt: 2400,
  ...patch,
});
const item = (tool: string, calls: ToolCall[], intent?: string): ToolItem => ({
  kind: "tool",
  id: "i1",
  tool,
  ...(intent === undefined ? {} : { intent }),
  calls,
});

describe("phrases of tool calls recorded from the pinned omp", () => {
  test("a finished read, edit, write and shell call read as the design's past tense", async () => {
    const [read, edit, write, bash] = await toolItems("tools");
    expect(text(toolPhrase(read as ToolItem))).toBe("Read notes.txt · 3 lines");
    expect(text(toolPhrase(edit as ToolItem))).toBe("Edited notes.txt · +1 -1");
    expect(text(toolPhrase(write as ToolItem))).toBe("Wrote done.txt · 1 line");
    expect(text(toolPhrase(bash as ToolItem))).toBe("Ran wc -l notes.txt · 61ms");
  });

  test("while running, the agent's own intent is the sentence, with an ellipsis", async () => {
    const [read] = await toolItems("tools");
    const live = {
      ...(read as ToolItem),
      calls: [{ ...(read as ToolItem).calls[0], status: "running" } as ToolCall],
    };
    expect(text(toolPhrase(live))).toBe("Reading notes file…");
  });

  test("failed read and failed shell command give what failed and why, in few words", async () => {
    const [read, bash] = await toolItems("failures");
    expect(text(toolPhrase(read as ToolItem))).toBe("Couldn’t read missing.txt · not found");
    expect(text(toolPhrase(bash as ToolItem))).toBe("echo oops; exit 3 failed · exit 3");
  });

  test("search results count matches and files; glob counts files", async () => {
    const items = await toolItems("search");
    const grep = items.find((i) => i.tool === "grep") as ToolItem;
    const glob = items.find((i) => i.tool === "glob") as ToolItem;
    expect(text(toolPhrase(grep))).toBe("Found 4 matches in 3 files");
    expect(text(toolPhrase(glob))).toBe("Found 2 files matching **/*.ts");
  });

  test("the todo tool reports progress, not the tool name", async () => {
    const items = await toolItems("todo");
    expect(text(toolPhrase(items[1] as ToolItem))).toBe("Todo · 1 of 2 done");
  });
});

describe("phrases the fixtures do not cover (built by hand from omp's documented shapes)", () => {
  test("one-match grammar and a search with no matches", () => {
    const one = item("grep", [
      call({
        target: "x",
        output: { kind: "matches", matchCount: 1, fileCount: 1, files: [], filesOmitted: 0 },
      }),
    ]);
    const none = item("grep", [
      call({
        target: "setTimeout",
        output: { kind: "matches", matchCount: 0, fileCount: 0, files: [], filesOmitted: 0 },
      }),
    ]);
    expect(text(toolPhrase(one))).toBe("Found 1 match in 1 file");
    expect(text(toolPhrase(none))).toBe("No matches for setTimeout");
  });

  test("a grouped line counts its commands and sums their time", () => {
    const group = item("bash", [
      call({ target: "git switch -c fix", startedAt: 0, endedAt: 1000 }),
      call({ target: "git push", startedAt: 1000, endedAt: 3100 }),
    ]);
    expect(text(toolPhrase(group))).toBe("Ran 2 commands · 3.1s");
  });

  test("a grouped read counts distinct files", () => {
    const group = item("read", [
      call({ target: "a.ts", output: { kind: "paths", count: 1, paths: ["a.ts"], lines: 100 } }),
      call({ target: "b.ts", output: { kind: "paths", count: 1, paths: ["b.ts"], lines: 42 } }),
    ]);
    expect(text(toolPhrase(group))).toBe("Read 2 files · 142 lines");
  });

  test("a timed-out command says so, with the time it waited", () => {
    const timedOut = item("bash", [
      call({
        status: "failed",
        target: "bun run build",
        error: "timed out",
        output: { kind: "shell", timedOut: true, wallTimeMs: 120_000, lines: [], linesOmitted: 0 },
      }),
    ]);
    expect(text(toolPhrase(timedOut))).toBe("Timed out after 2m · bun run build");
  });

  test("an MCP tool without an intent is named without its prefix", () => {
    const mcp = item("mcp__linear_list_issues", [call({ status: "running", endedAt: undefined })]);
    expect(text(toolPhrase(mcp))).toBe("Running linear_list_issues…");
  });

  test("a stopped call keeps the agent's words but drops the ellipsis", () => {
    const stopped = item("bash", [call({ status: "stopped" })], "Building the sidecar…");
    expect(text(toolPhrase(stopped))).toBe("Building the sidecar · stopped");
  });

  test("subagents: counts and the one that failed", () => {
    const agents = (statuses: ("completed" | "failed")[]) =>
      item("task", [
        call({
          status: statuses.includes("failed") ? "failed" : "done",
          output: {
            kind: "subagents",
            durationMs: 72_000,
            agents: statuses.map((status, i) => ({
              id: `${i}`,
              agent: "explore",
              description: "d",
              status,
            })),
          },
        }),
      ]);
    expect(text(toolPhrase(agents(["completed", "completed"])))).toBe("2 subagents done · 1m 12s");
    expect(text(toolPhrase(agents(["completed", "failed"])))).toBe("1 of 2 subagents failed");
  });
});

describe("durations and reasons", () => {
  test("formatDuration", () => {
    expect([
      formatDuration(72),
      formatDuration(2400),
      formatDuration(18_200),
      formatDuration(72_000),
      formatDuration(120_000),
    ]).toEqual(["72ms", "2.4s", "18s", "1m 12s", "2m"]);
  });

  test("the running timer counts seconds to 59s, then minutes with padded seconds", () => {
    expect([
      formatElapsed(0),
      formatElapsed(59_900),
      formatElapsed(64_000),
      formatElapsed(125_000),
    ]).toEqual(["0s", "59s", "1m 04s", "2m 05s"]);
  });

  test("shortReason maps known causes and cuts the rest at four words", () => {
    expect(shortReason("Path 'x' not found")).toBe("not found");
    expect(shortReason("Error: connection refused by the remote host today")).toBe(
      "connection refused by the…",
    );
    expect(shortReason(undefined)).toBe("");
  });
});

describe("thinking", () => {
  const thinking = (patch: Partial<ThinkingItem>): ThinkingItem => ({
    kind: "thinking",
    id: "t",
    text: "",
    done: false,
    startedAt: 0,
    ...patch,
  });

  test("tok/s shows only after 2 s and only when the provider counted tokens", () => {
    expect(tokensPerSecond(thinking({ tokens: 40 }), 1500)).toBeUndefined();
    expect(tokensPerSecond(thinking({ tokens: 84 }), 2000)).toBe(42);
    expect(tokensPerSecond(thinking({}), 9000)).toBeUndefined();
    expect(tokensPerSecond(thinking({ tokens: 100, done: true, endedAt: 5000 }), 99_000)).toBe(20);
  });

  test("the collapsed line is the first non-empty line of the reasoning", () => {
    expect(thinkingGist("\n  Suspecting a real timer.\nSecond line")).toBe(
      "Suspecting a real timer.",
    );
  });
});

describe("devices of the agent (`xd://`)", () => {
  test("a call to a device is named as a call, never as a file that was written", async () => {
    const items = await toolItems("search");
    const write = items.find((i) => i.tool === "write") as ToolItem;
    expect(text(toolPhrase(write))).toBe("Called ast_edit");
  });
});
