import { describe, expect, test } from "bun:test";
import type { Item, ThinkingItem, ToolItem } from "@omp-app/protocol";
import { toolItemStatus } from "@omp-app/protocol";
import { loadFixture } from "./replay";
import { newStore } from "./replay.test";

/** Replays a recorded run and returns the view model it ends in. */
async function replay(name: string) {
  const fixture = await loadFixture(name);
  const id = fixture.header.sessionId;
  const store = newStore(fixture);
  for (const event of fixture.events) store.dispatch(id, event);
  return store.snapshot(id).snapshot;
}

const tools = (timeline: readonly Item[], tool?: string): ToolItem[] =>
  timeline.filter(
    (i): i is ToolItem => i.kind === "tool" && (tool === undefined || i.tool === tool),
  );

describe("each timeline item type, replayed from events recorded with the pinned omp", () => {
  test("read: a file read keeps its path and line count, never the content", async () => {
    const [read] = tools((await replay("tools")).timeline, "read");
    expect(read?.intent).toBe("Reading notes file");
    expect(read?.calls[0]?.output).toMatchObject({ kind: "paths", lines: 3 });
    expect(JSON.stringify(read)).not.toContain("release notes");
  });

  test("edit: a numbered diff with the counts of the whole change", async () => {
    const [edit] = tools((await replay("tools")).timeline, "edit");
    const output = edit?.calls[0]?.output;
    expect(output?.kind).toBe("diff");
    if (output?.kind !== "diff") return;
    const [file] = output.files;
    expect(file).toMatchObject({ added: 1, removed: 1, rowsOmitted: 0 });
    expect(file?.rows.filter((r) => r.kind === "add")).toEqual([
      { kind: "add", newLine: 2, text: "status: final" },
    ]);
    expect(file?.rows.filter((r) => r.kind === "remove")).toEqual([
      { kind: "remove", oldLine: 2, text: "status: draft" },
    ]);
  });

  test("write: shows what was written as added rows", async () => {
    const [write] = tools((await replay("tools")).timeline, "write");
    const output = write?.calls[0]?.output;
    expect(output?.kind).toBe("diff");
    if (output?.kind !== "diff") return;
    expect(output.files[0]).toMatchObject({ op: "write", added: 1, removed: 0 });
  });

  test("shell: command, wall time and the tail of the output", async () => {
    const [bash] = tools((await replay("tools")).timeline, "bash");
    expect(bash?.calls[0]?.target).toBe("wc -l notes.txt");
    // omp reports an exit code only for a command that failed; success carries none.
    expect(bash?.calls[0]?.output).toEqual({
      kind: "shell",
      lines: ["3 notes.txt"],
      linesOmitted: 0,
      wallTimeMs: 61,
    });
    expect(bash?.calls[0]?.endedAt).toBeGreaterThan(
      bash?.calls[0]?.startedAt ?? Number.POSITIVE_INFINITY,
    );
  });

  test("failures: a missing file fails with omp's reason; a failing command keeps its output", async () => {
    const [read, bash] = tools((await replay("failures")).timeline);
    expect(read).toMatchObject({ tool: "read" });
    expect(toolItemStatus(read as ToolItem)).toBe("failed");
    expect(read?.calls[0]?.error).toBe("Path 'missing.txt' not found");
    expect(toolItemStatus(bash as ToolItem)).toBe("failed");
    expect(bash?.calls[0]?.output).toMatchObject({ kind: "shell", exitCode: 3 });
  });

  test("search: grep keeps counts and a few matches, glob keeps paths", async () => {
    const timeline = (await replay("search")).timeline;
    const grep = tools(timeline, "grep")[0]?.calls[0]?.output;
    expect(grep).toMatchObject({ kind: "matches", matchCount: 4, fileCount: 3 });
    const glob = tools(timeline, "glob")[0]?.calls[0]?.output;
    expect(glob).toMatchObject({ kind: "paths" });
  });

  test("a device call (`xd://`) is not shown as a file that was written", async () => {
    const writes = tools((await replay("search")).timeline, "write");
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w.calls[0]?.output).toBeUndefined();
  });

  test("todo: the checklist lives on the session and each todo call reports progress", async () => {
    const vm = await replay("todo");
    expect(vm.todo).toEqual([
      {
        name: "Tasks",
        tasks: [
          { content: "read notes", status: "completed" },
          { content: "report", status: "in_progress" },
        ],
      },
    ]);
    const calls = tools(vm.timeline, "todo");
    expect(calls.map((c) => c.calls[0]?.output?.kind)).toEqual(["todo", "todo"]);
  });

  test("thinking: closed with its duration, text kept; the answer follows it", async () => {
    const { timeline } = await replay("thinking");
    const thinking = timeline.find((i): i is ThinkingItem => i.kind === "thinking");
    expect(thinking?.done).toBe(true);
    expect(thinking?.text).toContain("17");
    expect((thinking?.endedAt ?? 0) - (thinking?.startedAt ?? 0)).toBeGreaterThan(0);
    const kinds = timeline.map((i) => i.kind);
    expect(kinds.indexOf("thinking")).toBeLessThan(kinds.indexOf("assistant"));
  });

  test("usage: tokens and cost are summed from the assistant messages", async () => {
    const vm = await replay("tools");
    expect(vm.usage.outputTokens).toBeGreaterThan(0);
    expect(vm.usage.cost).toBeGreaterThan(0);
  });
});

describe("compaction recorded from the pinned omp", () => {
  test("a real compaction becomes a boundary in the timeline, in the place it happened", async () => {
    const vm = await replay("compaction");
    const at = vm.timeline.findIndex((i) => i.kind === "compaction");
    expect(at).toBeGreaterThan(0);
    const item = vm.timeline[at];
    expect(item).toMatchObject({ kind: "compaction", state: "done", reason: "threshold" });
    expect(vm.timeline[at - 1]?.kind).not.toBe("compaction");
  });
});
