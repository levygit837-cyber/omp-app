import { describe, expect, test } from "bun:test";
import { ACTION_COMMAND_MESSAGE } from "@omp-app/protocol";
import { emptyViewModel } from "../src/reducer";
import { type SessionControl, sessionHandlers } from "../src/session-handlers";
import { SessionStore } from "../src/session-store";
import { noActions } from "./fixtures/no-actions";
import { noCommands } from "./fixtures/no-commands";
import { noPromptControls } from "./harness";

const client = { emit: () => {} };
const noRequests = { answerPermission() {}, answerAsk() {}, dismissSession() {} };

/**
 * A control whose builtin runs until it is stopped: the command is still running when the
 * action arrives, as `/compact` is for minutes (here `/effort`, which needs no confirmation) against a real model.
 */
function setup() {
  const calls: string[] = [];
  const started = Promise.withResolvers<AbortSignal>();
  const store = new SessionStore();
  store.create(emptyViewModel({ id: "s1", cwd: "/work", model: "p/m" }));
  const control: SessionControl = {
    ...noPromptControls,
    ...noCommands,
    ...noActions,
    list: async () => [],
    createSession: async () => "s1",
    resumeSession: async (id) => id,
    forkSession: async (id) => id,
    closeSession: async () => {},
    cancel: async () => {},
    prompt: async () => "end_turn",
    runCommand: (_id, _text, _output, signal) => {
      started.resolve(signal);
      const ended = Promise.withResolvers<{ failed: boolean }>();
      signal.addEventListener("abort", () => ended.resolve({ failed: true }), { once: true });
      return ended.promise;
    },
    saveCommand: () => {},
    clearContext: async (id) => {
      calls.push(`clear:${id}`);
      return {
        dropped: 0,
        cleared: { at: 1, context: null, queue: { steer: [], followUp: [] }, todo: [] },
      };
    },
    deleteSession: async (id, beforeClose) => {
      beforeClose();
      calls.push(`delete:${id}`);
      return 0;
    },
  };
  const handlers = sessionHandlers(control, store, noRequests);
  return { calls, started: started.promise, store, handlers };
}

describe("session actions while a builtin runs", () => {
  test("clearContext is refused while a command runs, and omp is not asked", async () => {
    const { calls, handlers, store, started } = setup();
    await handlers["session.runCommand"]({ sessionId: "s1", text: "/effort" }, client);
    const signal = await started;
    await expect(
      handlers["session.clearContext"]({ sessionId: "s1", confirmed: true }, client),
    ).rejects.toThrow(ACTION_COMMAND_MESSAGE);
    expect(calls).toEqual([]);
    expect(store.snapshot("s1").snapshot.timeline.map((i) => i.kind)).toEqual(["command"]);
    expect(signal.aborted).toBe(false);
  });

  test("delete stops the running command before the session closes", async () => {
    const { calls, handlers, store, started } = setup();
    await handlers["session.runCommand"]({ sessionId: "s1", text: "/effort" }, client);
    const signal = await started;
    await handlers["session.delete"]({ sessionId: "s1", confirmed: true }, client);
    expect(calls).toEqual(["delete:s1"]);
    expect(signal.aborted).toBe(true);
    expect(store.has("s1")).toBe(false);
  });
});
