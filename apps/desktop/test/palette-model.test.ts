import { describe, expect, test } from "bun:test";
import type { SlashCommand } from "@omp-app/protocol";
import {
  activate,
  buildView,
  commandsBlocked,
  completion,
  confirmFocus,
  moveSelection,
  type PaletteInput,
  parseQuery,
  rowsOf,
  sessionRefs,
  splitCommand,
} from "../src/renderer/palette/model";
import { isPaletteShortcut, type KeyLike } from "../src/renderer/palette/shortcut";

const cmd = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  aliases: [],
  description: `${name} description`,
  subcommands: [],
  ...extra,
});

const COMMANDS: SlashCommand[] = [
  cmd("model", { aliases: ["models"], description: "Pick the model" }),
  cmd("effort", { hint: "[level]", subcommands: [{ name: "high" }, { name: "low" }] }),
  cmd("switch", { hint: "<model>" }),
  cmd("export", {
    hint: "[--themes] [path]",
    confirm: { because: "Writes this session to an HTML file." },
  }),
  cmd("usage", {
    subcommands: [{ name: "show" }, { name: "reset", usage: "[account]" }],
    confirmVerbs: [{ verbs: ["reset"], because: "Spends a saved reset.", destructive: true }],
  }),
  cmd("session", {
    subcommands: [{ name: "info" }, { name: "delete" }],
    confirmVerbs: [{ verbs: ["delete"], because: "Deletes the file.", destructive: true }],
  }),
  cmd("mcp", {
    hint: "<subcommand>",
    subcommands: [{ name: "list" }, { name: "add", usage: "<name>" }],
  }),
];

const input = (over: Partial<PaletteInput> = {}): PaletteInput => ({
  sessions: [
    { id: "s1", title: "flaky supervisor test", project: "omp-app", focused: false },
    { id: "s2", title: "mcp.json loader", project: "omp-app", focused: false },
  ],
  actions: [
    { id: "new-session", label: "New session" },
    { id: "open-settings", label: "Open settings", shortcut: "⌘," },
  ],
  commands: { state: "ready", commands: COMMANDS },
  canPrompt: true,
  focusedTitle: "flaky supervisor test",
  ...over,
});

const labels = (raw: string, over?: Partial<PaletteInput>) =>
  buildView(raw, input(over)).groups.map((g) => [g.id, g.rows.map((r) => r.key)]);

describe("query", () => {
  test("a leading / or > picks the mode and is not part of the text", () => {
    expect(parseQuery("/mod")).toEqual({ mode: "commands", text: "mod" });
    expect(parseQuery(">new")).toEqual({ mode: "actions", text: "new" });
    expect(parseQuery("mod/")).toEqual({ mode: "all", text: "mod/" });
  });

  test("splits the command word from its arguments at the first space", () => {
    expect(splitCommand("effort")).toEqual({ word: "effort", args: null });
    expect(splitCommand("effort ")).toEqual({ word: "effort", args: "" });
    expect(splitCommand("effort  high now")).toEqual({ word: "effort", args: "high now" });
  });
});

describe("buildView", () => {
  test("with nothing typed, sessions, actions and commands show", () => {
    expect(buildView("", input()).groups.map((g) => g.id)).toEqual([
      "sessions",
      "actions",
      "commands",
    ]);
  });

  test("/ lists every command, not the few the mixed view shows", () => {
    const many = Array.from({ length: 12 }, (_, i) => cmd(`cmd${i}`));
    const commands = { state: "ready" as const, commands: many };
    expect(rowsOf(buildView("/", input({ commands }))).length).toBe(12);
    expect(
      rowsOf(buildView("", input({ commands }))).filter((r) => r.entry.kind === "command").length,
    ).toBeLessThan(12);
  });

  test("a prefix limits the content to one kind", () => {
    expect(buildView("/", input()).groups.map((g) => g.id)).toEqual(["commands"]);
    expect(buildView(">", input()).groups.map((g) => g.id)).toEqual(["actions"]);
  });

  test("the group with the best match comes first", () => {
    // The command `mcp` is the exact name; the session `mcp.json loader` only starts with it.
    expect(buildView("mcp", input()).groups.map((g) => g.id)).toEqual(["commands", "sessions"]);
    expect(buildView("mcp.j", input()).groups.map((g) => g.id)).toEqual(["sessions"]);
    expect(labels("/mcp")).toEqual([["commands", ["command:mcp"]]]);
  });

  test("a command is found by alias and by description", () => {
    expect(labels("/models")).toEqual([["commands", ["command:model"]]]);
    expect(rowsOf(buildView("/pick", input())).map((r) => r.key)).toEqual(["command:model"]);
  });

  test("a hit on a session is found by its project too", () => {
    expect(rowsOf(buildView("omp-app", input())).map((r) => r.key)).toEqual([
      "session:s1",
      "session:s2",
    ]);
  });

  test("nothing found: says so, and offers to send the text as a prompt", () => {
    const view = buildView("deploy staging", input());
    expect(view.kind).toBe("empty");
    expect(view.groups[0]?.rows[0]?.entry).toMatchObject({
      kind: "prompt",
      text: "deploy staging",
      sessionTitle: "flaky supervisor test",
    });
  });

  test("no prompt is offered where none can be sent", () => {
    expect(buildView("deploy staging", input({ canPrompt: false })).groups).toEqual([]);
    expect(buildView("/zzz", input()).groups).toEqual([]);
    expect(buildView(">zzz", input()).groups).toEqual([]);
  });

  test("while the commands load, / does not claim there are none", () => {
    const view = buildView("/mo", input({ commands: { state: "loading" } }));
    expect(view).toMatchObject({ kind: "list", note: "loading" });
    expect(buildView("/mo", input({ commands: { state: "failed" } }))).toMatchObject({
      kind: "list",
      note: "failed",
    });
  });

  test("with no session or a read-only app, / says why instead of listing", () => {
    for (const why of ["no-session", "read-only", "engine"] as const) {
      expect(buildView("/", input({ commands: { state: "unavailable", why } }))).toMatchObject({
        kind: "list",
        note: why,
      });
    }
    // The reason is for people who asked for commands; a plain search just finds the rest.
    expect(
      buildView("new", input({ commands: { state: "unavailable", why: "no-session" } })),
    ).toMatchObject({ kind: "list", note: null });
  });

  test("a long list is cut with a count of what is left, except `/`, which lists every command", () => {
    const many = Array.from({ length: 40 }, (_, i) => cmd(`c${String(i).padStart(2, "0")}`));
    const all = buildView("/", input({ commands: { state: "ready", commands: many } }));
    expect(all.groups[0]?.rows).toHaveLength(40);
    expect(all.groups[0]?.more).toBe(0);
    const idle = buildView("", input({ commands: { state: "ready", commands: many } }));
    const commands = idle.groups.find((g) => g.id === "commands");
    expect(commands?.rows).toHaveLength(6);
    expect(commands?.more).toBe(34);
    const typed = buildView("/c", input({ commands: { state: "ready", commands: many } }));
    expect(typed.groups[0]?.rows).toHaveLength(40);
    const search = buildView("c", input({ commands: { state: "ready", commands: many } }));
    const found = search.groups.find((g) => g.id === "commands");
    expect(found?.rows).toHaveLength(30);
    expect(found?.more).toBe(10);
  });

  test("after /name and a space, the first row runs the line as typed", () => {
    const view = buildView("/effort high", input());
    const rows = rowsOf(view);
    expect(rows[0]?.entry).toMatchObject({ kind: "run", args: "high" });
    // `high` is typed in full, so it is not offered again.
    expect(rows.map((r) => r.key)).toEqual(["run:effort"]);
    expect(rowsOf(buildView("/effort h", input())).map((r) => r.key)).toEqual([
      "run:effort",
      "sub:effort:high",
    ]);
    expect(rowsOf(buildView("/effort ", input())).map((r) => r.key)).toEqual([
      "run:effort",
      "sub:effort:high",
      "sub:effort:low",
    ]);
  });

  test("a command word that names nothing stays a search", () => {
    expect(rowsOf(buildView("/nope x", input()))).toEqual([]);
  });
});

describe("activate", () => {
  const row = (raw: string, n = 0) => rowsOf(buildView(raw, input()))[n]?.entry;

  test("a command with no argument runs; one that needs an argument asks for it first", () => {
    expect(activate(row("/model") as never)).toEqual({ do: "run", line: "/model" });
    expect(activate(row("/switch") as never)).toEqual({ do: "complete", raw: "/switch " });
    expect(activate(row("/mcp") as never)).toMatchObject({ do: "complete" });
  });

  test("an optional argument does not stop the command from running", () => {
    expect(activate(row("/effort") as never)).toEqual({ do: "run", line: "/effort" });
  });

  test("a command that reaches beyond the session is confirmed, with the reason", () => {
    expect(activate(row("/export") as never)).toEqual({
      do: "confirm",
      line: "/export",
      because: "Writes this session to an HTML file.",
      destructive: false,
    });
  });

  test("only the verbs that discard state are confirmed, and in the destructive variant", () => {
    // `info` and a bare /session run; `delete` asks, whether it was picked or typed.
    expect(activate(row("/session ", 1) as never)).toEqual({ do: "run", line: "/session info" });
    expect(activate(row("/session ", 2) as never)).toEqual({
      do: "confirm",
      line: "/session delete",
      because: "Deletes the file.",
      destructive: true,
    });
    expect(activate(row("/session DELETE", 0) as never)).toMatchObject({
      do: "confirm",
      destructive: true,
    });
    expect(activate(row("/usage show", 0) as never)).toEqual({ do: "run", line: "/usage show" });
    // A typed argument after the verb keeps the whole line.
    expect(activate(row("/usage reset anthropic/active", 0) as never)).toEqual({
      do: "confirm",
      line: "/usage reset anthropic/active",
      because: "Spends a saved reset.",
      destructive: true,
    });
  });

  test("the typed line keeps its arguments, and a required one cannot be empty", () => {
    expect(activate(row("/effort high") as never)).toEqual({ do: "run", line: "/effort high" });
    expect(activate(row("/switch ") as never)).toEqual({ do: "none" });
    expect(activate(row("/switch sonnet") as never)).toEqual({
      do: "run",
      line: "/switch sonnet",
    });
  });

  test("a subcommand with its own argument asks for it; one without runs", () => {
    expect(activate(row("/mcp ", 2) as never)).toEqual({ do: "complete", raw: "/mcp add " });
    expect(activate(row("/mcp ", 1) as never)).toEqual({ do: "run", line: "/mcp list" });
  });

  test("sessions, actions and prompts map to their own outcome", () => {
    expect(activate(row("flaky") as never)).toEqual({ do: "select-session", id: "s1" });
    expect(activate(row(">new") as never)).toEqual({ do: "action", id: "new-session" });
    expect(activate(row("deploy staging") as never)).toEqual({
      do: "prompt",
      text: "deploy staging",
    });
  });

  test("Tab completes a command or subcommand and nothing else", () => {
    expect(completion(row("/effort") as never)).toBe("/effort ");
    expect(completion(row("/effort ", 1) as never)).toBe("/effort high ");
    expect(completion(row("flaky") as never)).toBeNull();
  });
});

describe("selection", () => {
  test("wraps in both directions and survives an empty list", () => {
    expect(moveSelection(0, 3, -1)).toBe(2);
    expect(moveSelection(2, 3, 1)).toBe(0);
    expect(moveSelection(1, 3, 1)).toBe(2);
    expect(moveSelection(0, 0, 1)).toBe(0);
  });
});

describe("commandsBlocked", () => {
  test("names the first thing in the way", () => {
    expect(commandsBlocked({ sessionId: null, readOnly: true, engine: "failed" })).toBe(
      "no-session",
    );
    expect(commandsBlocked({ sessionId: "s", readOnly: true, engine: "failed" })).toBe("read-only");
    expect(commandsBlocked({ sessionId: "s", readOnly: false, engine: "restarting" })).toBe(
      "engine",
    );
    expect(commandsBlocked({ sessionId: "s", readOnly: false, engine: "ready" })).toBeNull();
  });
});

describe("sessionRefs", () => {
  const stored = [
    { id: "a", cwd: "/work/app", title: "first", modified: 3 },
    { id: "b", cwd: "/play/app", title: "second", modified: 2 },
  ] as never;

  test("the focused session goes last, projects are told apart, an unsaved one gets its replica title", () => {
    const refs = sessionRefs(
      stored,
      new Map([["new", "/tmp/x"]]),
      new Map([["new", "typed so far"]]),
      "a",
    );
    expect(refs.map((r) => r.id)).toEqual(["new", "b", "a"]);
    expect(refs.map((r) => r.project)).toEqual(["x", "play/app", "work/app"]);
    expect(refs[0]?.title).toBe("typed so far");
  });

  test("before the listing arrives, only open sessions show", () => {
    expect(sessionRefs(null, new Map([["n", "/tmp/x"]]), new Map(), null)).toHaveLength(1);
  });
});

describe("isPaletteShortcut", () => {
  const key = (over: Partial<KeyLike>): KeyLike => ({
    key: "k",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  test("a key an input method is composing is not the shortcut", () => {
    expect(isPaletteShortcut(key({ metaKey: true, isComposing: true }), true)).toBe(false);
  });

  test("⌘K on a Mac, Ctrl+K elsewhere, and only those", () => {
    expect(isPaletteShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isPaletteShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(key({ key: "K", metaKey: true }), true)).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isPaletteShortcut(key({ metaKey: true, key: "j" }), true)).toBe(false);
  });
});

describe("confirmFocus", () => {
  test("a confirm that discards state starts on Cancel, any other on Run", () => {
    expect(confirmFocus({ destructive: true })).toBe("cancel");
    expect(confirmFocus({ destructive: false })).toBe("run");
  });

  test("the focus follows what activate says about the line", () => {
    for (const [line, focus] of [
      ["/session delete", "cancel"],
      ["/usage reset", "cancel"],
      ["/export", "run"],
    ] as const) {
      const outcome = activate(rowsOf(buildView(line, input()))[0]?.entry as never);
      expect(outcome.do).toBe("confirm");
      if (outcome.do === "confirm") expect(confirmFocus(outcome)).toBe(focus);
    }
  });
});

describe("the This session group and the pause toggle", () => {
  const withSession = (over: Partial<PaletteInput> = {}) =>
    input({
      actions: [
        { id: "new-session", label: "New session" },
        { id: "fork-session", label: "Fork session", scope: "session" },
        { id: "clear-context", label: "Clear context", scope: "session", asks: true },
        { id: "delete-session", label: "Delete session", scope: "session", asks: true },
        { id: "toggle-pause", label: "Pause all agents", asks: true },
      ],
      ...over,
    });

  test("the actions on the focused session sit in their own group, ahead of app actions", () => {
    const groups = buildView(">", withSession()).groups;
    expect(groups.map((g) => [g.id, g.label])).toEqual([
      ["session", "This session"],
      ["actions", "App actions"],
    ]);
    expect(groups[0]?.rows.map((r) => r.key)).toEqual([
      "action:fork-session",
      "action:clear-context",
      "action:delete-session",
    ]);
    expect(groups[1]?.rows.map((r) => r.key)).toEqual([
      "action:new-session",
      "action:toggle-pause",
    ]);
  });

  test("an action that asks first yields ask, one that does not yields action", () => {
    const rows = rowsOf(buildView(">", withSession()));
    const entry = (key: string) => rows.find((r) => r.key === key)?.entry as never;
    expect(activate(entry("action:clear-context"))).toEqual({ do: "ask", id: "clear-context" });
    expect(activate(entry("action:delete-session"))).toEqual({ do: "ask", id: "delete-session" });
    expect(activate(entry("action:toggle-pause"))).toEqual({ do: "ask", id: "toggle-pause" });
    expect(activate(entry("action:fork-session"))).toEqual({ do: "action", id: "fork-session" });
  });

  test("resume asks nothing: the row is a plain action", () => {
    const view = buildView(
      ">resume",
      withSession({ actions: [{ id: "toggle-pause", label: "Resume all agents" }] }),
    );
    const [row] = rowsOf(view);
    expect(row?.entry && activate(row.entry)).toEqual({ do: "action", id: "toggle-pause" });
  });

  test("typing finds the actions by their words, whichever group they are in", () => {
    expect(rowsOf(buildView("delete", withSession())).map((r) => r.key)).toContain(
      "action:delete-session",
    );
    expect(rowsOf(buildView("pause", withSession())).map((r) => r.key)).toContain(
      "action:toggle-pause",
    );
  });
});
