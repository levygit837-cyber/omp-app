import { describe, expect, test } from "bun:test";
import {
  applyOp,
  isPlanReadResult,
  isPlanState,
  isSessionViewModel,
  methodWrites,
  type SessionViewModel,
} from "../src/index";

const empty: SessionViewModel = {
  id: "s1",
  cwd: "/work",
  status: "idle",
  model: null,
  timeline: [],
  warnings: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
  context: null,
  todo: [],
  pending: [],
  thinking: null,
  queue: { steering: [], followUp: [], liveSteered: 0 },
  plan: { enabled: false, planFile: null },
};

describe("plan.set", () => {
  test("replaces the plan state and leaves the rest of the view model alone", () => {
    const on = applyOp(empty, {
      type: "plan.set",
      plan: { enabled: true, planFile: "local://PLAN.md" },
    });
    expect(on).toEqual({ ...empty, plan: { enabled: true, planFile: "local://PLAN.md" } });
    expect(applyOp(on, { type: "plan.set", plan: { enabled: false, planFile: null } })).toEqual(
      empty,
    );
  });

  test("the same state is the same object, so a replica does not re-render", () => {
    const on = applyOp(empty, {
      type: "plan.set",
      plan: { enabled: true, planFile: "local://a.md" },
    });
    expect(
      applyOp(on, { type: "plan.set", plan: { enabled: true, planFile: "local://a.md" } }),
    ).toBe(on);
  });
});

describe("guards", () => {
  test("a view model without a plan, or with a malformed one, is refused", () => {
    expect(isSessionViewModel(empty)).toBe(true);
    const { plan: _plan, ...without } = empty;
    expect(isSessionViewModel(without)).toBe(false);
    expect(isSessionViewModel({ ...empty, plan: { enabled: "yes", planFile: null } })).toBe(false);
    expect(isSessionViewModel({ ...empty, plan: { enabled: true } })).toBe(false);
  });

  test("plan state", () => {
    expect(isPlanState({ enabled: true, planFile: "local://x-plan.md" })).toBe(true);
    expect(isPlanState({ enabled: false, planFile: null })).toBe(true);
    expect(isPlanState({ enabled: false, planFile: 3 })).toBe(false);
    expect(isPlanState(null)).toBe(false);
  });

  test("plan read results", () => {
    const ok = { state: "ok", file: "local://a-plan.md", content: "# a", earlier: false };
    expect(isPlanReadResult(ok)).toBe(true);
    expect(isPlanReadResult({ ...ok, earlier: undefined })).toBe(false);
    expect(isPlanReadResult({ state: "ok", file: "local://a-plan.md", earlier: false })).toBe(
      false,
    );
    expect(isPlanReadResult({ state: "missing" })).toBe(true);
    expect(isPlanReadResult({ state: "refused", reason: "too_large" })).toBe(true);
    expect(isPlanReadResult({ state: "refused", reason: "because" })).toBe(false);
    expect(isPlanReadResult({ state: "gone" })).toBe(false);
  });
});

test("neither plan method is a write: a read-only sidecar still serves them", () => {
  expect(methodWrites["session.setPlanMode"]).toBe(false);
  expect(methodWrites["session.readPlan"]).toBe(false);
});
