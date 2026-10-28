import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { CreateElicitationRequest, RequestPermissionRequest } from "@oh-my-pi/pi-utils/acp";
import { applyOp, type DecisionOutcome, type SessionOpEvent } from "@omp-app/protocol";
import { emptyViewModel } from "../src/reducer";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { sessionHandlers } from "../src/session-handlers";
import { SessionStore } from "../src/session-store";
import { noActions } from "./fixtures/no-actions";
import { noCommands } from "./fixtures/no-commands";
import { noPromptControls } from "./harness";

const SID = "s1";

/** The lifecycle members of `SessionControl` that these tests never reach. */
const idle = {
  ...noPromptControls,
  ...noCommands,
  ...noActions,
  list: async () => [],
  resumeSession: async (id: string) => id,
  forkSession: async (id: string) => id,
  closeSession: async () => {},
};

function setup() {
  const store = new SessionStore();
  store.create(emptyViewModel({ id: SID, cwd: "/work", model: null }));
  const ops: SessionOpEvent[] = [];
  store.subscribe(SID, "test", (e) => ops.push(e));
  const registry = new RequestRegistry(store, () => 1000);
  return { store, registry, ops };
}

// The options omp sends (`acp-permission-gate.ts` PERMISSION_OPTIONS).
const OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
  { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
] as const;

const bash = (command: string, toolCallId = "tc1"): RequestPermissionRequest => ({
  sessionId: SID,
  toolCall: {
    toolCallId,
    title: command,
    kind: "execute",
    status: "pending",
    rawInput: { command },
    content: [{ type: "content", content: { type: "text", text: `$ ${command}` } }],
    locations: [],
  },
  options: [...OPTIONS],
});

// Shapes `createAcpExtensionUiContext` sends (`acp-agent.ts:625-700`).
const form = (
  message: string,
  properties: Record<string, Record<string, unknown>>,
  required?: string[],
): CreateElicitationRequest => ({
  mode: "form",
  sessionId: SID,
  message,
  requestedSchema: { type: "object", properties: properties as never, required },
});

/** The value, or a failing test: what a `!` would assert without saying so. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

const pendingOf = (store: SessionStore) => store.snapshot(SID).snapshot.pending;
const timelineOf = (store: SessionStore) => store.snapshot(SID).snapshot.timeline;

describe("permission requests", () => {
  test("a gated call shows the four options and the exact command, and survives a reload", async () => {
    const { store, registry } = setup();
    const answer = registry.permission(bash("rm -rf build && echo 'done'"));

    const [request] = pendingOf(store);
    expect(request).toMatchObject({
      kind: "permission",
      toolCallId: "tc1",
      payload: "rm -rf build && echo 'done'",
      raisedAt: 1000,
    });
    expect(request?.kind === "permission" && request.options.map((o) => o.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
      "reject_always",
    ]);

    // A window that reloads subscribes again and gets the same request in the snapshot.
    const late = store.subscribe(SID, "reloaded", () => {});
    expect(late.snapshot.pending).toEqual(pendingOf(store));
    expect(late.snapshot.pending).toHaveLength(1);

    registry.answerPermission(SID, must(request).id, "allow_once");
    expect(await answer).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
  });

  test.each<[string, DecisionOutcome]>([
    ["allow_once", "allowed_once"],
    ["allow_always", "allowed_always"],
    ["reject_once", "rejected_once"],
    ["reject_always", "rejected_always"],
  ])("%s answers omp with that option and leaves one decision line", async (optionId, outcome) => {
    const { store, registry } = setup();
    const answer = registry.permission(bash("ls"));
    registry.answerPermission(SID, must(pendingOf(store)[0]).id, optionId);

    expect(await answer).toEqual({ outcome: { outcome: "selected", optionId } });
    expect(pendingOf(store)).toEqual([]);
    expect(timelineOf(store)).toEqual([
      { kind: "decision", id: "i0", outcome, subject: "ls", toolKind: "execute" },
    ]);
  });

  test("an option that was not offered is refused and the request keeps waiting", async () => {
    const { store, registry } = setup();
    let settled = false;
    const answer = registry.permission(bash("ls")).then((r) => {
      settled = true;
      return r;
    });
    const id = must(pendingOf(store)[0]).id;
    expect(() => registry.answerPermission(SID, id, "allow_forever")).toThrow("not an offered");
    // Let every already-queued continuation run: a wrongly settled promise would have by now.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(pendingOf(store)).toHaveLength(1);

    registry.answerPermission(SID, id, "reject_once");
    expect((await answer).outcome).toEqual({ outcome: "selected", optionId: "reject_once" });
  });

  test("answering twice, or a request that is gone, is a stale-request error", async () => {
    const { store, registry } = setup();
    void registry.permission(bash("ls"));
    const id = must(pendingOf(store)[0]).id;
    registry.answerPermission(SID, id, "allow_once");
    expect(() => registry.answerPermission(SID, id, "allow_once")).toThrow("stale request");
    expect(() => registry.answerPermission(SID, "req-99", "allow_once")).toThrow("stale request");
  });

  test("user steers: omp aborts the signal, the request disappears and omp hears cancelled", async () => {
    const { store, registry, ops } = setup();
    const steer = new AbortController();
    const answer = registry.permission(bash("sleep 60"), steer.signal);
    expect(pendingOf(store)).toHaveLength(1);

    steer.abort();
    expect(await answer).toEqual({ outcome: { outcome: "cancelled" } });
    expect(pendingOf(store)).toEqual([]);
    expect(timelineOf(store)).toEqual([]); // nothing was decided: no line
    expect(ops.map((o) => o.op.type)).toEqual(["request.add", "request.settle"]);
  });

  test("a request omp already withdrew is never shown", async () => {
    const { store, registry } = setup();
    const steer = new AbortController();
    steer.abort();
    expect(await registry.permission(bash("ls"), steer.signal)).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(pendingOf(store)).toEqual([]);
  });

  test("turn cancelled (Esc): session.cancel drops every request of the session", async () => {
    const { store, registry } = setup();
    const permission = registry.permission(bash("ls"));
    const ask = registry.elicitation(form("Pick", { value: { type: "boolean" } }, ["value"]));
    expect(pendingOf(store)).toHaveLength(2);

    const cancelled: string[] = [];
    const handlers = sessionHandlers(
      {
        ...idle,
        createSession: async () => SID,
        prompt: async () => "end_turn",
        cancel: async (id) => void cancelled.push(id),
      },
      store,
      registry,
    );
    await handlers["session.cancel"]({ sessionId: SID }, {} as never);

    expect(cancelled).toEqual([SID]);
    expect(pendingOf(store)).toEqual([]);
    expect(timelineOf(store)).toEqual([]);
    expect(await permission).toEqual({ outcome: { outcome: "cancelled" } });
    expect(await ask).toEqual({ action: "cancel" });
  });

  test("tool aborts: the end of that tool call removes only its request", async () => {
    const { store, registry } = setup();
    const first = registry.permission(bash("a", "tc-a"));
    void registry.permission(bash("b", "tc-b"));

    registry.agentEvent(SID, {
      type: "tool_execution_end",
      toolCallId: "tc-a",
      toolName: "bash",
      result: {},
      isError: true,
    } as AgentSessionEvent);

    expect(await first).toEqual({ outcome: { outcome: "cancelled" } });
    expect(pendingOf(store).map((r) => r.kind === "permission" && r.toolCallId)).toEqual(["tc-b"]);
  });

  test("the turn ending removes whatever is still pending", async () => {
    const { store, registry } = setup();
    void registry.permission(bash("a"));
    registry.agentEvent(SID, { type: "agent_end", messages: [] } as AgentSessionEvent);
    expect(pendingOf(store)).toEqual([]);
  });

  test("two requests queue in order; answering the first brings the second forward", async () => {
    const { store, registry } = setup();
    const a = registry.permission(bash("first", "tc-a"));
    const b = registry.permission(bash("second", "tc-b"));
    const [first, second] = pendingOf(store);
    expect([first?.id, second?.id]).not.toContain(undefined);
    expect(first?.kind === "permission" && first.payload).toBe("first");

    registry.answerPermission(SID, must(first).id, "reject_once");
    expect((await a).outcome).toEqual({ outcome: "selected", optionId: "reject_once" });
    expect(pendingOf(store)).toEqual([must(second)]);

    registry.answerPermission(SID, must(second).id, "allow_once");
    await b;
    expect(timelineOf(store).map((i) => i.kind === "decision" && i.outcome)).toEqual([
      "rejected_once",
      "allowed_once",
    ]);
  });

  test("a request for a session this sidecar does not know is cancelled, never shown", async () => {
    const { registry } = setup();
    expect(await registry.permission({ ...bash("ls"), sessionId: "ghost" })).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  test("a fresh sidecar has no memory of an old request: answering it is an unknown session", async () => {
    const { store, registry } = setup();
    void registry.permission(bash("ls"));
    const id = must(pendingOf(store)[0]).id;

    // The sidecar restarted: new store, new registry, the session is gone.
    const reborn = new SessionStore();
    const handlers = sessionHandlers(
      {
        ...idle,
        createSession: async () => SID,
        prompt: async () => "end_turn",
        cancel: async () => {},
      },
      reborn,
      new RequestRegistry(reborn),
    );
    await expect(
      handlers["session.answerPermission"](
        { sessionId: SID, requestId: id, optionId: "allow_once" },
        {} as never,
      ),
    ).rejects.toThrow("unknown session");
  });
});

describe("ask forms", () => {
  test("select from omp's askDialog schema: choices, descriptions, default, and the other box", async () => {
    const { store, registry } = setup();
    const answer = registry.elicitation(
      form("Which color?", {
        q0: {
          type: "string",
          title: "Which color?",
          oneOf: [
            { const: "azul", title: "azul" },
            { const: "verde", title: "verde", description: "calm" },
          ],
          default: "verde",
        },
        q0__other: { type: "string", title: "Other" },
      }),
    );
    const [request] = pendingOf(store);
    expect(request).toMatchObject({
      kind: "ask",
      message: "Which color?",
      fields: [
        {
          key: "q0",
          type: "select",
          title: "Which color?",
          choices: [
            { value: "azul", label: "azul" },
            { value: "verde", label: "verde", description: "calm" },
          ],
          otherKey: "q0__other",
          otherLabel: "Other",
          default: "verde",
        },
      ],
    });

    registry.answerAsk(SID, must(request).id, "accept", { q0: "azul" });
    expect(await answer).toEqual({ action: "accept", content: { q0: "azul" } });
    expect(timelineOf(store)).toEqual([
      { kind: "decision", id: "i0", outcome: "answered", subject: "Which color?", detail: "azul" },
    ]);
  });

  test("the other box wins over the choice and is trimmed", async () => {
    const { store, registry } = setup();
    const answer = registry.elicitation(
      form("Color?", {
        q0: { type: "string", oneOf: [{ const: "azul", title: "azul" }] },
        q0__other: { type: "string", title: "Other" },
      }),
    );
    registry.answerAsk(SID, must(pendingOf(store)[0]).id, "accept", {
      q0: "azul",
      q0__other: "  roxo ",
    });
    expect(await answer).toEqual({ action: "accept", content: { q0__other: "roxo" } });
    expect(timelineOf(store)[0]).toMatchObject({ detail: "roxo" });
  });

  test("multi select, confirm and input from `ask`, `confirm` and `input` schemas", async () => {
    const { store, registry } = setup();
    const multi = registry.elicitation(
      form("Pick some", {
        q0: {
          type: "array",
          title: "Pick some",
          items: {
            anyOf: [
              { const: "a", title: "a" },
              { const: "b", title: "b" },
            ],
          },
        },
      }),
    );
    const confirm = registry.elicitation(
      form("Delete?\n\nsure?", { value: { type: "boolean" } }, ["value"]),
    );
    const input = registry.elicitation(
      form("Name?", { value: { type: "string", description: "e.g. foo" } }, ["value"]),
    );
    const [m, c, i] = pendingOf(store);
    expect(m?.kind === "ask" && m.fields[0]?.type).toBe("multi");
    expect(c?.kind === "ask" && c.fields[0]?.type).toBe("confirm");
    expect(i?.kind === "ask" && i.fields[0]).toMatchObject({
      type: "input",
      description: "e.g. foo",
      required: true,
    });

    registry.answerAsk(SID, must(m).id, "accept", { q0: ["a", "b"] });
    registry.answerAsk(SID, must(c).id, "accept", { value: false });
    registry.answerAsk(SID, must(i).id, "accept", { value: "bar" });
    expect(await multi).toEqual({ action: "accept", content: { q0: ["a", "b"] } });
    expect(await confirm).toEqual({ action: "accept", content: { value: false } });
    expect(await input).toEqual({ action: "accept", content: { value: "bar" } });
    expect(timelineOf(store).map((i) => i.kind === "decision" && i.detail)).toEqual([
      "a, b",
      "no",
      "bar",
    ]);
  });

  test("an answer the form did not offer is refused and the form keeps waiting", async () => {
    const { store, registry } = setup();
    void registry.elicitation(
      form("Pick", { value: { type: "string", enum: ["a", "b"] } }, ["value"]),
    );
    const id = must(pendingOf(store)[0]).id;
    expect(() => registry.answerAsk(SID, id, "accept", { value: "c" })).toThrow("offered");
    expect(() => registry.answerAsk(SID, id, "accept", {})).toThrow("needs an answer");
    expect(() => registry.answerAsk(SID, id, "accept", { value: "a", extra: "x" })).toThrow(
      "unknown answer field",
    );
    expect(pendingOf(store)).toHaveLength(1);
  });

  test("decline answers omp with decline and leaves a cancelled line", async () => {
    const { store, registry } = setup();
    const answer = registry.elicitation(form("Name?", { value: { type: "string" } }));
    registry.answerAsk(SID, must(pendingOf(store)[0]).id, "decline", undefined);
    expect(await answer).toEqual({ action: "decline" });
    expect(timelineOf(store)[0]).toMatchObject({ outcome: "cancelled" });
  });

  test("the ask tool ending closes its form (form elicitations carry no cancel signal)", async () => {
    const { store, registry } = setup();
    const answer = registry.elicitation(form("Name?", { value: { type: "string" } }));
    registry.agentEvent(SID, {
      type: "tool_execution_end",
      toolCallId: "tc-ask",
      toolName: "ask",
      result: {},
    } as AgentSessionEvent);
    expect(await answer).toEqual({ action: "cancel" });
    expect(pendingOf(store)).toEqual([]);
  });

  test("a schema the form cannot show is declined, not shown with a question missing", async () => {
    const { store, registry } = setup();
    const answer = registry.elicitation(form("Count?", { n: { type: "number" } }));
    expect(await answer).toEqual({ action: "decline" });
    expect(pendingOf(store)).toEqual([]);
  });
});

describe("who may answer", () => {
  test("an answer of the other kind is stale and changes nothing", async () => {
    const { store, registry } = setup();
    const permission = registry.permission(bash("rm -rf x"));
    const ask = registry.elicitation(form("Name?", { value: { type: "string" } }));
    const [p, a] = pendingOf(store);

    expect(() => registry.answerAsk(SID, must(p).id, "accept", undefined)).toThrow("stale request");
    expect(() => registry.answerPermission(SID, must(a).id, "allow_once")).toThrow("stale request");
    // Nothing was settled, nothing was written to the timeline, both still wait.
    expect(pendingOf(store)).toHaveLength(2);
    expect(timelineOf(store)).toEqual([]);

    registry.answerPermission(SID, must(p).id, "reject_once");
    registry.answerAsk(SID, must(a).id, "accept", { value: "x" });
    expect(await permission).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    expect(await ask).toEqual({ action: "accept", content: { value: "x" } });
  });

  test("another session's id cannot answer", () => {
    const { store, registry } = setup();
    void registry.permission(bash("ls"));
    expect(() =>
      registry.answerPermission("s2", must(pendingOf(store)[0]).id, "allow_once"),
    ).toThrow("stale request");
    expect(pendingOf(store)).toHaveLength(1);
  });
});

// omp asks to approve a plan with this exact shape [V] acp-agent.ts:2411-2425. It reaches the
// person only because the sidecar declares `elicitation.form`.
describe("plan approval", () => {
  const PLAN_MESSAGE =
    'Approve plan "Rename the "config" loader" and start implementation?\n\n1. Read src/config.ts\n2. Rename `load` to `loadConfig`\n\n   - keep the old name exported\n3. Update callers\n…';
  const planForm = () =>
    form(
      PLAN_MESSAGE,
      { value: { type: "string", enum: ["Approve and execute", "Refine plan"] } },
      ["value"],
    );

  test("the multi-line message and both choices reach the view model unchanged", async () => {
    const { store, registry } = setup();
    const answer = registry.elicitation(planForm());

    expect(pendingOf(store)[0]).toMatchObject({
      kind: "ask",
      message: PLAN_MESSAGE,
      fields: [
        {
          key: "value",
          type: "select",
          required: true,
          choices: [
            { value: "Approve and execute", label: "Approve and execute" },
            { value: "Refine plan", label: "Refine plan" },
          ],
        },
      ],
    });

    registry.answerAsk(SID, must(pendingOf(store)[0]).id, "accept", {
      value: "Approve and execute",
    });
    expect(await answer).toEqual({ action: "accept", content: { value: "Approve and execute" } });
    // The question was a whole plan; the line it leaves in the chat is its first line.
    expect(timelineOf(store)[0]).toMatchObject({
      outcome: "answered",
      subject: 'Approve plan "Rename the "config" loader" and start implementation?',
      detail: "Approve and execute",
    });
  });

  test("it is not withdrawn by an unrelated tool ending, only by the turn", async () => {
    const { store, registry } = setup();
    const answer = registry.elicitation(planForm());
    registry.agentEvent(SID, {
      type: "tool_execution_end",
      toolCallId: "tc-x",
      toolName: "bash",
      result: {},
    } as AgentSessionEvent);
    expect(pendingOf(store)).toHaveLength(1);

    registry.agentEvent(SID, { type: "agent_end", messages: [] } as AgentSessionEvent);
    expect(await answer).toEqual({ action: "cancel" });
    expect(pendingOf(store)).toEqual([]);
  });
});

describe("the session bridge", () => {
  test("a tool ending in the agent's event stream withdraws its request", async () => {
    const store = new SessionStore();
    const registry = new RequestRegistry(store, () => 1000);
    let emit: (event: AgentSessionEvent) => void = () => {};
    const session = {
      sessionId: SID,
      model: undefined,
      sessionManager: {
        getCwd: () => "/work",
        getBranch: () => [],
        getSessionId: () => SID,
        onPersistenceNotice: () => () => {},
      },
      buildTranscriptSessionContext: () => ({ messages: [] }),
      thinkingLevel: "off",
      configuredThinkingLevel: () => "off",
      subscribe: (listener: (event: AgentSessionEvent) => void) => {
        emit = listener;
        return () => {};
      },
    } as unknown as AgentSession;
    attachSession(store, session, registry);

    const answer = registry.permission(bash("sleep 99", "tc-run"));
    expect(pendingOf(store)).toHaveLength(1);
    emit({
      type: "tool_execution_end",
      toolCallId: "tc-run",
      toolName: "bash",
      result: {},
      isError: true,
    } as AgentSessionEvent);

    expect(await answer).toEqual({ outcome: { outcome: "cancelled" } });
    expect(pendingOf(store)).toEqual([]);
  });
});

describe("view model ops", () => {
  test("a replica that applies the ops reaches the sidecar's state at every cut", async () => {
    const { store, registry, ops } = setup();
    void registry.permission(bash("ls"));
    void registry.elicitation(form("Name?", { value: { type: "string" } }));
    registry.answerPermission(SID, must(pendingOf(store)[0]).id, "allow_once");
    registry.dismissSession(SID);

    const replica = ops.reduce(
      (vm, o) => applyOp(vm, o.op),
      emptyViewModel({ id: SID, cwd: "/work", model: null }),
    );
    expect(replica).toEqual(store.snapshot(SID).snapshot);
    expect(ops.map((o) => o.seq)).toEqual(ops.map((_, i) => i + 1));
  });

  test("request.add twice with one id keeps one request; settling an unknown id is a no-op", () => {
    const vm = emptyViewModel({ id: SID, cwd: "/work", model: null });
    const request = {
      kind: "ask" as const,
      id: "r",
      message: "m",
      fields: [],
      raisedAt: 1,
    };
    const once = applyOp(vm, { type: "request.add", request });
    expect(applyOp(once, { type: "request.add", request })).toBe(once);
    expect(applyOp(once, { type: "request.settle", requestId: "nope" })).toBe(once);
  });
});

describe("a session that moved to a new id", () => {
  // ACP keeps calling the session by the id it was registered with, so omp's requests still
  // carry the old one after the store re-keyed it.
  const NEW = "s2";
  const pendingOfNew = (store: SessionStore) => store.snapshot(NEW).snapshot.pending;

  test("a permission raised under the old id lands in the new id's pending and is answered under either id", async () => {
    const { store, registry } = setup();
    store.rekey(SID, NEW);

    const first = registry.permission(bash("ls", "tc-a"));
    const second = registry.permission(bash("pwd", "tc-b"));
    const [a, b] = pendingOfNew(store);
    expect(pendingOfNew(store)).toHaveLength(2);
    expect(a).toMatchObject({ kind: "permission", toolCallId: "tc-a" });

    registry.answerPermission(SID, must(a).id, "allow_once");
    registry.answerPermission(NEW, must(b).id, "reject_once");
    expect(await first).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
    expect(await second).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    expect(pendingOfNew(store)).toEqual([]);
    expect(store.snapshot(NEW).snapshot.timeline.map((i) => i.kind)).toEqual([
      "decision",
      "decision",
    ]);
  });

  test("an ask raised under the old id lands in the new id's pending and is answered under either id", async () => {
    const { store, registry } = setup();
    store.rekey(SID, NEW);

    const answer = registry.elicitation(form("Pick", { q0: { type: "boolean" } }, ["q0"]));
    const [request] = pendingOfNew(store);
    expect(request).toMatchObject({ kind: "ask", message: "Pick" });

    registry.answerAsk(SID, must(request).id, "accept", { q0: true });
    expect(await answer).toEqual({ action: "accept", content: { q0: true } });
    expect(pendingOfNew(store)).toEqual([]);

    const again = registry.elicitation(form("Again", { q0: { type: "boolean" } }, ["q0"]));
    registry.answerAsk(NEW, must(pendingOfNew(store)[0]).id, "decline", undefined);
    expect(await again).toEqual({ action: "decline" });
  });

  test("a request raised before the move is answered under the new id, and cancel reaches it", async () => {
    const { store, registry } = setup();
    const before = registry.permission(bash("ls", "tc-a"));
    const id = must(pendingOf(store)[0]).id;
    store.rekey(SID, NEW);
    expect(pendingOfNew(store)).toHaveLength(1);

    registry.answerPermission(NEW, id, "allow_once");
    expect(await before).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });

    const open = registry.permission(bash("pwd", "tc-b"));
    registry.dismissSession(NEW);
    expect(await open).toEqual({ outcome: { outcome: "cancelled" } });
    expect(pendingOfNew(store)).toEqual([]);
  });
});
