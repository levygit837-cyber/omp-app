import { describe, expect, spyOn, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { SessionStore } from "../src/session-store";

/** A session that hands its listener back, so the test can emit events the way omp does. */
function fakeSession() {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const session = {
    sessionId: "s",
    sessionManager: {
      getCwd: () => "/w",
      getBranch: () => [],
      getSessionId: () => "s",
      onPersistenceNotice: () => () => {},
    },
    buildTranscriptSessionContext: () => ({ messages: [] }),
    model: { provider: "p", id: "m", api: "anthropic-messages", input: ["text"], compat: {} },
    settings: Settings.isolated(),
    thinkingLevel: "off",
    configuredThinkingLevel: () => "off",
    getContextUsage: () => ({ tokens: 500, contextWindow: 10_000, percent: 5 }),
    subscribe: (fn: (event: AgentSessionEvent) => void) => {
      listener = fn;
      return () => {};
    },
  } as unknown as AgentSession;
  return { session, emit: (event: AgentSessionEvent) => listener?.(event) };
}

const messageEnd = {
  type: "message_end",
  message: { role: "user", content: "x" },
} as AgentSessionEvent;

describe("attachSession", () => {
  test("a message_end updates the context meter", () => {
    const store = new SessionStore();
    const { session, emit } = fakeSession();
    attachSession(store, session, new RequestRegistry(store));
    emit(messageEnd);
    expect(store.snapshot("s").snapshot.context).toMatchObject({ tokens: 500, window: 10_000 });
  });

  test("a throw in the reducer is logged, and the context meter is still updated", () => {
    const store = new SessionStore();
    store.dispatch = () => {
      throw new Error("reducer bug");
    };
    const log = spyOn(console, "error").mockImplementation(() => {});
    const { session, emit } = fakeSession();
    attachSession(store, session, new RequestRegistry(store));
    expect(() => emit(messageEnd)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("reducer on message_end");
    expect(store.snapshot("s").snapshot.context).toMatchObject({ tokens: 500 });
    log.mockRestore();
  });

  test("a throw while withdrawing requests is logged, and the context meter is still updated", () => {
    const store = new SessionStore();
    const requests = {
      agentEvent: () => {
        throw new Error("registry bug");
      },
    };
    const log = spyOn(console, "error").mockImplementation(() => {});
    const { session, emit } = fakeSession();
    attachSession(store, session, requests);
    expect(() => emit(messageEnd)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("request withdrawal on message_end");
    expect(store.snapshot("s").snapshot.context).toMatchObject({ tokens: 500 });
    log.mockRestore();
  });

  test("an event that does not change the context size does not read it", () => {
    const store = new SessionStore();
    const { session, emit } = fakeSession();
    attachSession(store, session, new RequestRegistry(store));
    emit({ type: "agent_start" } as AgentSessionEvent);
    expect(store.snapshot("s").snapshot.context).toBeNull();
  });
});
