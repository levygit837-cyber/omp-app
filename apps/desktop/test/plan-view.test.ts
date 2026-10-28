import { describe, expect, test } from "bun:test";
import type { AskRequest, PendingRequest } from "@omp-app/protocol";
import {
  APPROVE_CHOICE,
  cancelNoteFor,
  isPlanApproval,
  keyLeavesPlan,
  nextCenterView,
  PLAN_CANCEL_NOTE,
  pendingProposal,
  planFileName,
  planPage,
  planToggleView,
  REFINE_CHOICE,
} from "../src/renderer/plan-view";
import { CANCEL_NOTE } from "../src/renderer/requests-view";

const choice = (value: string) => ({ value, label: value });
const approval = (id = "r1"): AskRequest => ({
  kind: "ask",
  id,
  message: 'Approve plan "x" and start implementation?',
  fields: [
    {
      key: "value",
      type: "select",
      required: true,
      choices: [choice(APPROVE_CHOICE), choice(REFINE_CHOICE)],
    },
  ],
  raisedAt: 0,
});
const colors: AskRequest = {
  ...approval("r2"),
  fields: [
    {
      key: "q0",
      type: "select",
      required: false,
      choices: [choice("azul"), choice("verde")],
    },
  ],
};
const permission: PendingRequest = {
  kind: "permission",
  id: "p1",
  title: "ls",
  toolKind: "execute",
  options: [],
  raisedAt: 0,
} as unknown as PendingRequest;

describe("isPlanApproval", () => {
  test("only omp's own two-choice select counts", () => {
    expect(isPlanApproval(approval())).toBe(true);
    expect(isPlanApproval(colors)).toBe(false);
    expect(isPlanApproval(permission)).toBe(false);
  });

  test("a select that merely contains the choices, or has them reversed, is a question of the agent", () => {
    const [field] = approval().fields;
    const withExtra = {
      ...approval(),
      fields: [{ ...field, choices: [choice(APPROVE_CHOICE), choice(REFINE_CHOICE), choice("x")] }],
    } as AskRequest;
    const reversed = {
      ...approval(),
      fields: [{ ...field, choices: [choice(REFINE_CHOICE), choice(APPROVE_CHOICE)] }],
    } as AskRequest;
    expect(isPlanApproval(withExtra)).toBe(false);
    expect(isPlanApproval(reversed)).toBe(false);
  });
});

describe("cancelNoteFor", () => {
  test("cancelling the plan approval is a refine, any other question stops the agent", () => {
    expect(cancelNoteFor(approval())).toBe(PLAN_CANCEL_NOTE);
    expect(cancelNoteFor(colors)).toBe(CANCEL_NOTE);
  });
});

describe("pendingProposal", () => {
  test("is the approval question while plan mode is on, the oldest first", () => {
    expect(pendingProposal(true, [colors, approval("a"), approval("b")])?.id).toBe("a");
  });

  test("outside plan mode the same question is just a question", () => {
    expect(pendingProposal(false, [approval()])).toBeUndefined();
  });
});

describe("planToggleView", () => {
  const base = { enabled: false, streaming: false, engineReady: true, readOnly: false };

  test("between turns it can be switched", () => {
    expect(planToggleView(base)).toEqual({
      shown: true,
      pressed: false,
      locked: false,
      reason: null,
      reasonInBar: false,
    });
    expect(planToggleView({ ...base, enabled: true }).pressed).toBe(true);
  });

  test("during a turn it is locked and the bar's own sentence is the reason", () => {
    // No tooltip of its own: the control points at the visible sentence instead.
    expect(planToggleView({ ...base, streaming: true })).toMatchObject({
      locked: true,
      reason: null,
      reasonInBar: true,
    });
  });

  test("without an engine it is locked with a tooltip, since the bar says nothing then", () => {
    expect(planToggleView({ ...base, engineReady: false })).toMatchObject({
      locked: true,
      reason: "omp isn’t running",
      reasonInBar: false,
    });
  });

  test("a locked toggle keeps its state", () => {
    expect(planToggleView({ ...base, enabled: true, streaming: true }).pressed).toBe(true);
  });

  test("a read-only sidecar has nothing to switch, so nothing is drawn", () => {
    expect(planToggleView({ ...base, readOnly: true }).shown).toBe(false);
  });
});

describe("planPage", () => {
  test("every refusal is a sentence and none shows the path", () => {
    for (const reason of ["not_local", "outside_session", "too_large", "not_a_file"] as const) {
      const page = planPage({ status: "done", result: { state: "refused", reason } });
      expect(page.kind).toBe("problem");
      if (page.kind === "problem") expect(page.text).toMatch(/\.$/);
    }
  });

  test("a plan that is not there is empty, not a problem", () => {
    expect(planPage({ status: "done", result: { state: "missing" } }).kind).toBe("empty");
  });

  test("a plan carries its text through untouched", () => {
    expect(
      planPage({
        status: "done",
        result: { state: "ok", file: "local://a-plan.md", content: "# A\n", earlier: false },
      }),
    ).toEqual({ kind: "plan", file: "local://a-plan.md", content: "# A\n", earlier: false });
  });

  test("a plan omp re-entered is carried as earlier, so the view can say so", () => {
    expect(
      planPage({
        status: "done",
        result: { state: "ok", file: "local://a-plan.md", content: "# A\n", earlier: true },
      }),
    ).toMatchObject({ kind: "plan", earlier: true });
  });

  test("loading and failing", () => {
    expect(planPage({ status: "loading" }).kind).toBe("loading");
    expect(planPage({ status: "failed", text: "omp isn’t running." })).toEqual({
      kind: "problem",
      text: "omp isn’t running.",
    });
  });
});

test("planFileName drops the scheme", () => {
  expect(planFileName("local://rename-plan.md")).toBe("rename-plan.md");
  expect(planFileName("local:/rename-plan.md")).toBe("rename-plan.md");
});

describe("keyLeavesPlan", () => {
  test("Esc leaves, other keys do not", () => {
    expect(keyLeavesPlan("Escape", false, false)).toBe(true);
    expect(keyLeavesPlan("Enter", false, false)).toBe(false);
  });

  test("Esc belongs to the band or the stop button when they claim it, and to Settings while the view is inert", () => {
    expect(keyLeavesPlan("Escape", false, true)).toBe(false);
    expect(keyLeavesPlan("Escape", true, false)).toBe(false);
  });
});

describe("nextCenterView", () => {
  const idle = {
    current: "chat" as const,
    planEnabled: true,
    proposalId: undefined,
    shownProposalId: undefined,
  };

  test("a new proposal opens the plan once", () => {
    const opened = nextCenterView({ ...idle, proposalId: "a" });
    expect(opened).toEqual({ view: "plan", shownProposalId: "a" });
    // The person went back to the chat: the same proposal does not pull them again.
    expect(
      nextCenterView({ ...idle, current: "chat", proposalId: "a", shownProposalId: "a" }).view,
    ).toBe("chat");
  });

  test("a refined proposal is a new one and opens the plan again", () => {
    expect(
      nextCenterView({ ...idle, current: "chat", proposalId: "b", shownProposalId: "a" }),
    ).toEqual({ view: "plan", shownProposalId: "b" });
  });

  test("the view survives the answer while plan mode stays on (refine)", () => {
    expect(
      nextCenterView({ ...idle, current: "plan", proposalId: undefined, shownProposalId: "a" }),
    ).toEqual({ view: "plan", shownProposalId: "a" });
  });

  test("leaving plan mode (approve) returns to the chat and forgets the proposal", () => {
    expect(
      nextCenterView({ ...idle, current: "plan", planEnabled: false, shownProposalId: "a" }),
    ).toEqual({ view: "chat", shownProposalId: undefined });
  });
});
