import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ContextFill, SessionOp } from "@omp-app/protocol";
import { readContextFill } from "../src/context-fill";
import { emptyViewModel } from "../src/reducer";
import { SessionStore } from "../src/session-store";

/**
 * `readContextFill` reads three things off the session: `getContextUsage()`, `settings` and
 * `model`. The settings are omp's own (`Settings.isolated`: in memory, no file touched), so the
 * compaction boundary is whatever the pinned omp computes from them.
 */
function fakeSession(
  usage: { tokens: number; contextWindow: number; percent: number } | undefined,
  overrides: Record<string, unknown> = {},
): AgentSession {
  return {
    getContextUsage: () => usage,
    settings: Settings.isolated(overrides),
    model: { provider: "p", id: "m", api: "anthropic-messages", input: ["text"], compat: {} },
  } as unknown as AgentSession;
}

describe("readContextFill", () => {
  test("omp cannot measure yet: no context", () => {
    expect(readContextFill(fakeSession(undefined))).toBeNull();
  });

  test("a window of zero or less is no context", () => {
    expect(readContextFill(fakeSession({ tokens: 10, contextWindow: 0, percent: 0 }))).toBeNull();
    expect(
      readContextFill(fakeSession({ tokens: 10, contextWindow: Number.NaN, percent: 0 })),
    ).toBeNull();
  });

  test("tokens are rounded and the window is carried as omp measured it", () => {
    const fill = readContextFill(
      fakeSession({ tokens: 14_999.6, contextWindow: 200_000, percent: 7.5 }),
    );
    expect(fill).toMatchObject({ tokens: 15_000, window: 200_000 });
  });

  test("with auto-compaction on, the point it triggers at is a token count inside the window", () => {
    const fill = readContextFill(fakeSession({ tokens: 1, contextWindow: 200_000, percent: 0 }));
    expect(fill?.compactAtTokens).toBeGreaterThan(0);
    expect(fill?.compactAtTokens).toBeLessThanOrEqual(200_000);
  });

  test("with compaction off, the boundary is null and the field is left out, not zero", () => {
    const fill = readContextFill(
      fakeSession(
        { tokens: 1, contextWindow: 200_000, percent: 0 },
        { "compaction.enabled": false },
      ),
    );
    expect(fill).toEqual({ tokens: 1, window: 200_000 });
    expect(fill).not.toHaveProperty("compactAtTokens");
  });
});

describe("SessionStore.setContext", () => {
  const FILL: ContextFill = { tokens: 100, window: 1000, compactAtTokens: 900 };

  function open() {
    const store = new SessionStore(() => 1000);
    store.create(emptyViewModel({ id: "s", cwd: "/w", model: null }));
    const ops: SessionOp[] = [];
    store.subscribe("s", "k", (event) => ops.push(event.op));
    return { store, ops };
  }

  test("a change emits one context.set op and lands in the snapshot", () => {
    const { store, ops } = open();
    store.setContext("s", FILL);
    expect(ops).toEqual([{ type: "context.set", context: FILL }]);
    expect(store.snapshot("s").snapshot.context).toEqual(FILL);
  });

  test("the same value again emits nothing and does not advance seq", () => {
    const { store, ops } = open();
    store.setContext("s", FILL);
    const seq = store.snapshot("s").seq;
    store.setContext("s", { ...FILL });
    expect(ops).toHaveLength(1);
    expect(store.snapshot("s").seq).toBe(seq);
  });

  test("null on a session that has none emits nothing; null after a value clears it", () => {
    const { store, ops } = open();
    store.setContext("s", null);
    expect(ops).toEqual([]);
    store.setContext("s", FILL);
    store.setContext("s", null);
    expect(ops.map((o) => o.type)).toEqual(["context.set", "context.set"]);
    expect(store.snapshot("s").snapshot.context).toBeNull();
  });

  test("a changed token count is a new op", () => {
    const { store, ops } = open();
    store.setContext("s", FILL);
    store.setContext("s", { ...FILL, tokens: 200 });
    expect(ops).toHaveLength(2);
  });
});
