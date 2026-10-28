import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSubagentStatus, loadPersistedSubagents } from "../src/persisted-subagents";
import { fixturesDir } from "./replay";

let root: string;
let n = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "omp-app-persisted-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A root session file path whose artifacts directory exists, laid out like omp's. */
function newSession(): { sessionFile: string; dir: string } {
  const base = join(root, `s${n++}`);
  mkdirSync(base, { recursive: true });
  const dir = join(base, "2026-01-01T00-00-00-000Z_root");
  mkdirSync(dir);
  return { sessionFile: `${dir}.jsonl`, dir };
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

interface Msg {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  stopReason?: string;
  usage?: unknown;
  [k: string]: unknown;
}

/** A transcript as omp writes it: header, session_init, then a chain of message entries. */
function transcript(opts: { agent?: string; task?: string; messages: Msg[] }): string[] {
  const rows: unknown[] = [
    { type: "session", version: 3, id: "sub", timestamp: iso(0), cwd: "/work/project" },
    {
      type: "session_init",
      id: "init",
      parentId: null,
      timestamp: iso(10),
      systemPrompt: ["sys"],
      task: opts.task ?? "do it",
      tools: [],
      ...(opts.agent === undefined ? {} : { agent: opts.agent }),
    },
  ];
  let parent = "init";
  opts.messages.forEach((message, i) => {
    const id = `m${i}`;
    rows.push({
      type: "message",
      id,
      parentId: parent,
      timestamp: iso(100 * (i + 1)),
      message: { timestamp: T0 + 100 * (i + 1), ...message },
    });
    parent = id;
  });
  return rows.map((r) => JSON.stringify(r));
}

const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }] });
const answer = (text: string, stopReason = "stop"): Msg => ({
  role: "assistant",
  provider: "p",
  model: "m",
  stopReason,
  content: [{ type: "text", text }],
  usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 0, totalTokens: 1015 },
});

function put(dir: string, name: string, lines: readonly string[]): string {
  const file = join(dir, name);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe("deriveSubagentStatus", () => {
  test("a tombstone wins over a clean ending", () => {
    expect(deriveSubagentStatus([{ role: "assistant", stopReason: "stop" }], true)).toBe("aborted");
  });
  test("ends on an answer: completed (a truncated answer is still one)", () => {
    expect(deriveSubagentStatus([{ role: "assistant", stopReason: "stop" }], false)).toBe(
      "completed",
    );
    expect(deriveSubagentStatus([{ role: "assistant", stopReason: "length" }], false)).toBe(
      "completed",
    );
  });
  test("error stop reason: failed; aborted stop reason: aborted", () => {
    expect(deriveSubagentStatus([{ role: "assistant", stopReason: "error" }], false)).toBe(
      "failed",
    );
    expect(deriveSubagentStatus([{ role: "assistant", stopReason: "aborted" }], false)).toBe(
      "aborted",
    );
  });
  test("cut off: no messages, last is not an assistant, or it stopped to call tools", () => {
    expect(deriveSubagentStatus([], false)).toBe("aborted");
    expect(deriveSubagentStatus([{ role: "user" }], false)).toBe("aborted");
    expect(
      deriveSubagentStatus(
        [{ role: "assistant", stopReason: "stop" }, { role: "toolResult" }],
        false,
      ),
    ).toBe("aborted");
    expect(deriveSubagentStatus([{ role: "assistant", stopReason: "toolUse" }], false)).toBe(
      "aborted",
    );
  });
});

describe("loadPersistedSubagents", () => {
  test("a recorded subagent transcript loads with its tool call and final answer", async () => {
    const { sessionFile, dir } = newSession();
    copyFileSync(join(fixturesDir, "subagent-transcript.jsonl"), join(dir, "UnitedRaccoon.jsonl"));

    const [sub, ...rest] = await loadPersistedSubagents(sessionFile);
    expect(rest).toEqual([]);
    if (!sub) throw new Error("no subagent");
    expect(sub.id).toBe("UnitedRaccoon");
    expect(sub.agent).toBe("task");
    expect(sub.status).toBe("completed");
    // The recorded task's "# Target" section is all this fixture's description can be.
    expect(sub.description).toBe("None; read-only.");
    expect(sub.tokens).toBeGreaterThan(0);
    expect(sub.model).toMatch(/\//);
    expect(sub.endedAt).toBeGreaterThanOrEqual(sub.startedAt);

    const tool = sub.timeline.find((i) => i.kind === "tool");
    expect(tool?.kind === "tool" && tool.tool).toBe("bash");
    const last = sub.timeline.at(-1);
    expect(last?.kind).toBe("assistant");
    expect(last?.kind === "assistant" && last.text).toContain("hello");
  });

  test("tokens count input plus output of every assistant message, never cache reads", async () => {
    const { sessionFile, dir } = newSession();
    put(
      dir,
      "A.jsonl",
      transcript({ messages: [user("q"), answer("one"), user("q2"), answer("two")] }),
    );
    const [sub] = await loadPersistedSubagents(sessionFile);
    expect(sub?.tokens).toBe(30);
  });

  test("a tombstone marks the subagent aborted", async () => {
    const { sessionFile, dir } = newSession();
    const file = put(dir, "A.jsonl", transcript({ messages: [user("q"), answer("done")] }));
    writeFileSync(`${file}.tombstone`, "");
    expect((await loadPersistedSubagents(sessionFile))[0]?.status).toBe("aborted");
  });

  test("a transcript that ends without a final answer is aborted", async () => {
    const { sessionFile, dir } = newSession();
    put(dir, "A.jsonl", transcript({ messages: [user("q")] }));
    expect((await loadPersistedSubagents(sessionFile))[0]?.status).toBe("aborted");
  });

  test("an error stop reason is failed", async () => {
    const { sessionFile, dir } = newSession();
    put(dir, "A.jsonl", transcript({ messages: [user("q"), answer("oops", "error")] }));
    expect((await loadPersistedSubagents(sessionFile))[0]?.status).toBe("failed");
  });

  test("agent and description come from session_init; description is the Target section", async () => {
    const { sessionFile, dir } = newSession();
    put(
      dir,
      "A.jsonl",
      transcript({
        agent: "reviewer",
        task: "Complete it.\n\n# Target\nReview   the\nparser.\n# Change\nnothing",
        messages: [user("q"), answer("ok")],
      }),
    );
    const [sub] = await loadPersistedSubagents(sessionFile);
    expect(sub?.agent).toBe("reviewer");
    expect(sub?.description).toBe("Review the parser.");
  });

  test("a malformed line is skipped, a file that is not a transcript is skipped, the rest load", async () => {
    const { sessionFile, dir } = newSession();
    const good = transcript({ messages: [user("q"), answer("fine")] });
    put(dir, "Good.jsonl", [good[0] ?? "", "{not json", ...good.slice(1)]);
    put(dir, "Garbage.jsonl", ["not json at all", "[1,2"]);
    writeFileSync(join(dir, "Empty.jsonl"), "");
    const subs = await loadPersistedSubagents(sessionFile);
    expect(subs.map((s) => s.id)).toEqual(["Good"]);
    expect(subs[0]?.status).toBe("completed");
  });

  test("the advisor transcript is not a subagent", async () => {
    const { sessionFile, dir } = newSession();
    const lines = transcript({ messages: [user("q"), answer("x")] });
    put(dir, "__advisor.jsonl", lines);
    put(dir, "__advisor.security.jsonl", lines);
    put(dir, "Real.jsonl", lines);
    expect((await loadPersistedSubagents(sessionFile)).map((s) => s.id)).toEqual(["Real"]);
  });

  test("a missing artifacts directory, or a path that is not a session file, gives none", async () => {
    expect(await loadPersistedSubagents(join(root, "nowhere", "x.jsonl"))).toEqual([]);
    expect(await loadPersistedSubagents(join(root, "nowhere"))).toEqual([]);
  });

  test("ordered by start time, nested subagents carry their parent", async () => {
    const { sessionFile, dir } = newSession();
    const withHeaderAt = (offset: number): string[] => {
      const lines = transcript({ messages: [user("q"), answer("x")] });
      lines[0] = JSON.stringify({
        type: "session",
        version: 3,
        id: "s",
        timestamp: iso(offset),
        cwd: "/w",
      });
      return lines;
    };
    put(dir, "Late.jsonl", withHeaderAt(5000));
    put(dir, "Early.jsonl", withHeaderAt(1000));
    put(dir, "Parent.jsonl", withHeaderAt(3000));
    mkdirSync(join(dir, "Parent"));
    put(join(dir, "Parent"), "Child.jsonl", withHeaderAt(4000));

    const subs = await loadPersistedSubagents(sessionFile);
    expect(subs.map((s) => s.id)).toEqual(["Early", "Parent", "Child", "Late"]);
    expect(subs.find((s) => s.id === "Child")?.parentId).toBe("Parent");
    expect(subs.find((s) => s.id === "Parent")?.parentId).toBeUndefined();
  });

  test("a large number of transcripts all load", async () => {
    const { sessionFile, dir } = newSession();
    const lines = transcript({ messages: [user("q"), answer("x")] });
    for (let i = 0; i < 300; i++) put(dir, `S${i}.jsonl`, lines);
    expect(await loadPersistedSubagents(sessionFile)).toHaveLength(300);
  });
});
