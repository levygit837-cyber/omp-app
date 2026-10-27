import type { Item, ToolCall, ToolItem } from "@omp-app/protocol";

/**
 * A deterministic mixed timeline for `FAKE_MIXED=1`: every turn is a user prompt, reasoning,
 * a read, an edit with a diff, a shell call, a search, and a markdown answer with a code block.
 * Seven items per turn, so row heights vary and every renderer path is on screen.
 */
const T0 = 1_700_000_000_000;

const call = (turn: number, n: number, patch: Partial<ToolCall>): ToolCall => ({
  toolCallId: `c-${turn}-${n}`,
  status: "done",
  startedAt: T0 + turn * 60_000 + n * 1000,
  endedAt: T0 + turn * 60_000 + n * 1000 + 400 + ((turn * 37 + n * 11) % 900),
  ...patch,
});

const tool = (
  turn: number,
  n: number,
  name: string,
  intent: string,
  c: Partial<ToolCall>,
): ToolItem => ({
  kind: "tool",
  id: `t-${turn}-${n}`,
  tool: name,
  intent,
  calls: [call(turn, n, c)],
});

export function mixedTimeline(count: number): Item[] {
  const items: Item[] = [];
  for (let turn = 0; items.length < count; turn++) {
    const file = `src/module-${turn % 17}.ts`;
    items.push({
      kind: "user",
      id: `u-${turn}`,
      text: `Turn ${turn}: make ${file} retry once on failure.`,
    });
    items.push({
      kind: "thinking",
      id: `k-${turn}`,
      text: `The retry belongs in one place.\nCheck ${file} first, then decide where the loop goes (turn ${turn}).`,
      done: true,
      startedAt: T0 + turn * 60_000,
      endedAt: T0 + turn * 60_000 + 1500 + (turn % 5) * 700,
    });
    items.push(
      tool(turn, 1, "read", "Reading the module", {
        target: file,
        output: { kind: "paths", count: 1, paths: [file], lines: 40 + (turn % 90) },
      }),
    );
    items.push(
      tool(turn, 2, "edit", "Adding the retry", {
        target: file,
        output: {
          kind: "diff",
          files: [
            {
              path: file,
              op: "update",
              added: 3,
              removed: 1,
              rowsOmitted: 0,
              rows: [
                {
                  kind: "context",
                  oldLine: 11,
                  newLine: 11,
                  text: "export async function run() {",
                },
                { kind: "remove", oldLine: 12, text: "  return await attempt();" },
                { kind: "add", newLine: 12, text: "  try {" },
                { kind: "add", newLine: 13, text: "    return await attempt();" },
                { kind: "add", newLine: 14, text: "  } catch { return await attempt(); }" },
                { kind: "context", oldLine: 13, newLine: 15, text: "}" },
              ],
            },
          ],
        },
      }),
    );
    items.push(
      tool(turn, 3, "bash", "Running the tests", {
        target: "bun test src",
        output: {
          kind: "shell",
          wallTimeMs: 900 + turn * 13,
          lines: [
            `bun test v1`,
            ` ${10 + (turn % 7)} pass`,
            " 0 fail",
            `Ran ${10 + (turn % 7)} tests`,
          ],
          linesOmitted: turn % 3 === 0 ? 24 : 0,
        },
      }),
    );
    items.push(
      tool(turn, 4, "grep", "Searching for callers", {
        target: "attempt",
        output: {
          kind: "matches",
          matchCount: 3,
          fileCount: 2,
          filesOmitted: 0,
          files: [
            {
              path: "src/a.ts",
              count: 2,
              lines: [
                { line: 4, text: "attempt()" },
                { line: 9, text: "await attempt()" },
              ],
            },
            { path: "src/b.ts", count: 1, lines: [{ line: 31, text: "attempt(opts)" }] },
          ],
        },
      }),
    );
    items.push({
      kind: "assistant",
      id: `a-${turn}`,
      done: true,
      text: [
        `**${file}** now retries once.`,
        "",
        "```ts",
        "try {",
        "  return await attempt();",
        "} catch {",
        "  return await attempt();",
        "}",
        "```",
        "",
        `- tests pass (${10 + (turn % 7)})`,
        turn % 2 === 0
          ? "- one caller still passes `opts`; see [the docs](https://example.com/retry)."
          : "- no other callers changed.",
      ].join("\n"),
    });
  }
  return items.slice(0, count);
}

/**
 * `FAKE_MIXED=states`: one of each state a live omp cannot produce on demand (grouped commands,
 * a failed call, a retry that recovered and one that gave up, a compaction, subagents, a todo).
 */
export function stateTimeline(): Item[] {
  const at = (s: number) => T0 + s * 1000;
  const grouped: ToolItem = {
    kind: "tool",
    id: "g1",
    tool: "bash",
    intent: "Created and pushed fix/double-restart",
    calls: [
      {
        toolCallId: "g1a",
        status: "done",
        startedAt: at(10),
        endedAt: at(11),
        target: "git switch -c fix/double-restart",
        output: {
          kind: "shell",
          wallTimeMs: 220,
          lines: ["Switched to a new branch 'fix/double-restart'"],
          linesOmitted: 0,
        },
      },
      {
        toolCallId: "g1b",
        status: "done",
        startedAt: at(11),
        endedAt: at(14),
        target: "git push -u origin fix/double-restart",
        output: {
          kind: "shell",
          wallTimeMs: 2900,
          lines: ["branch 'fix/double-restart' set up to track 'origin/fix/double-restart'."],
          linesOmitted: 0,
        },
      },
    ],
  };
  return [
    { kind: "user", id: "s-u1", text: "Make the supervisor restart idempotent, then push it." },
    {
      kind: "thinking",
      id: "s-k1",
      text: "One restart per crash, however many events the child emits.\nThe flag belongs on the supervisor.",
      done: true,
      startedAt: at(1),
      endedAt: at(9),
    },
    tool(0, 1, "edit", "Adding a restarting flag", {
      target: "supervisor.ts",
      output: {
        kind: "diff",
        files: [
          {
            path: "supervisor.ts",
            op: "update",
            added: 9,
            removed: 4,
            rowsOmitted: 0,
            rows: [
              { kind: "context", oldLine: 40, newLine: 40, text: "  onCrash() {" },
              { kind: "remove", oldLine: 41, text: "    this.restart();" },
              { kind: "add", newLine: 41, text: "    if (this.restarting) return;" },
              { kind: "add", newLine: 42, text: "    this.restarting = true;" },
              { kind: "add", newLine: 43, text: "    this.restart();" },
              { kind: "context", oldLine: 42, newLine: 44, text: "  }" },
            ],
          },
        ],
      },
    }),
    grouped,
    {
      kind: "tool",
      id: "s-f1",
      tool: "read",
      intent: "Reading the config",
      calls: [
        {
          toolCallId: "s-f1c",
          status: "failed",
          startedAt: at(20),
          endedAt: at(20),
          target: "missing.txt",
          error: "Path 'missing.txt' not found",
        },
      ],
    },
    {
      kind: "tool",
      id: "s-f2",
      tool: "bash",
      intent: "Building the project",
      calls: [
        {
          toolCallId: "s-f2c",
          status: "failed",
          startedAt: at(21),
          endedAt: at(140),
          target: "bun run build",
          error: "timed out",
          output: {
            kind: "shell",
            timedOut: true,
            wallTimeMs: 120000,
            lines: ["bundling 412 modules…"],
            linesOmitted: 0,
          },
        },
      ],
    },
    {
      kind: "tool",
      id: "s-t1",
      tool: "task",
      intent: "Checking both callers",
      calls: [
        {
          toolCallId: "s-t1c",
          status: "done",
          startedAt: at(150),
          endedAt: at(222),
          output: {
            kind: "subagents",
            durationMs: 72000,
            agents: [
              {
                id: "a1",
                agent: "explore",
                description: "Find callers of onCrash",
                status: "completed",
                durationMs: 41000,
                tokens: 18200,
              },
              {
                id: "a2",
                agent: "explore",
                description: "Check the fake clock test",
                status: "failed",
                durationMs: 22000,
                tokens: 9100,
              },
            ],
          },
        },
      ],
    },
    {
      kind: "retry",
      id: "s-r1",
      state: "recovered",
      attempt: 2,
      maxAttempts: 3,
      retryAt: at(230),
      startedAt: at(225),
      endedAt: at(231),
      error: "Model overloaded (529)",
    },
    {
      kind: "retry",
      id: "s-r2",
      state: "failed",
      attempt: 3,
      maxAttempts: 3,
      retryAt: at(260),
      startedAt: at(240),
      endedAt: at(261),
      error: "Model overloaded (529)",
    },
    {
      kind: "compaction",
      id: "s-c1",
      state: "done",
      reason: "threshold",
      action: "context-full",
      startedAt: at(270),
      endedAt: at(280),
      tokensBefore: 184000,
      summary:
        "Goal: make the supervisor restart idempotent.\nDone: restarting flag, push of fix/double-restart.\nOpen: fake clock test.",
    },
    {
      kind: "assistant",
      id: "s-a1",
      done: true,
      text: "The restart is now **idempotent**: a second `onCrash()` during a restart is ignored.\n\n- branch `fix/double-restart` is pushed\n- the fake clock test is still open",
    },
  ];
}
