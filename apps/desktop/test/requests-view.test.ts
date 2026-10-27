import { describe, expect, test } from "bun:test";
import type { AskField, AskRequest, PermissionRequest } from "@omp-app/protocol";
import { describeError } from "../src/renderer/errors";
import { sessionMark } from "../src/renderer/format";
import {
  canSend,
  createBandKeys,
  draftContent,
  initialDraft,
  KEY_GRACE_MS,
  type KeyInput,
  type KeyTarget,
  keyAnswer as keyAnswerAfter,
  targetOf,
} from "../src/renderer/requests-view";

const permission: PermissionRequest = {
  kind: "permission",
  id: "req-1",
  toolCallId: "tc1",
  title: "git push",
  toolKind: "execute",
  payload: "git push",
  paths: [],
  options: [],
  raisedAt: 0,
};

const ask = (fields: AskField[]): AskRequest => ({
  kind: "ask",
  id: "req-2",
  message: "Which?",
  fields,
  raisedAt: 0,
});

const select: AskField = {
  key: "q0",
  type: "select",
  required: true,
  choices: [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ],
  otherKey: "q0__other",
};
const confirm: AskField = { key: "value", type: "confirm", required: true };

const press = (key: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  repeat: false,
  ...extra,
});

/** A key pressed once the request has been on screen long enough to be read. */
const keyAnswer = (
  request: Parameters<typeof keyAnswerAfter>[0],
  input: KeyInput,
  target: KeyTarget,
  sinceShownMs = KEY_GRACE_MS,
) => keyAnswerAfter(request, input, target, sinceShownMs);

describe("keys on a permission", () => {
  test("Enter allows once, Alt+Enter allows always, Esc rejects once", () => {
    expect(keyAnswer(permission, press("Enter"), "page")).toEqual({
      type: "option",
      kind: "allow_once",
    });
    expect(keyAnswer(permission, press("Enter", { altKey: true }), "band")).toEqual({
      type: "option",
      kind: "allow_always",
    });
    expect(keyAnswer(permission, press("Escape"), "page")).toEqual({
      type: "option",
      kind: "reject_once",
    });
  });

  test("a focused button keeps its own Enter, so Tab then Enter presses that button", () => {
    expect(keyAnswer(permission, press("Enter"), "button")).toBeNull();
  });

  test("a draft in the input bar is never taken over, an empty one still answers", () => {
    for (const key of ["Enter", "Escape", "y", "1"]) {
      expect(keyAnswer(permission, press(key), "foreign")).toBeNull();
    }
    expect(keyAnswer(permission, press("Enter"), "empty-field")).toEqual({
      type: "option",
      kind: "allow_once",
    });
    expect(keyAnswer(ask([confirm]), press("y"), "empty-field")).toBeNull();
  });

  test("a held key never answers, and nothing answers before the request could be read", () => {
    for (const target of ["page", "band", "empty-field"] as const) {
      expect(keyAnswer(permission, press("Enter", { repeat: true }), target)).toBeNull();
      expect(keyAnswer(permission, press("Escape", { repeat: true }), target)).toBeNull();
      expect(keyAnswer(permission, press("Enter"), target, KEY_GRACE_MS - 1)).toBeNull();
      expect(keyAnswer(permission, press("Escape"), target, 0)).toBeNull();
      expect(keyAnswer(permission, press("Enter"), target, KEY_GRACE_MS)).toEqual({
        type: "option",
        kind: "allow_once",
      });
    }
    expect(keyAnswer(ask([select]), press("2"), "band", KEY_GRACE_MS - 1)).toBeNull();
    expect(keyAnswer(ask([select]), press("2", { repeat: true }), "band")).toBeNull();
  });

  test("composing text and shortcuts with Cmd or Ctrl are left alone", () => {
    expect(keyAnswer(permission, press("Enter", { isComposing: true }), "page")).toBeNull();
    expect(keyAnswer(permission, press("Enter", { metaKey: true }), "page")).toBeNull();
  });
});

describe("keys on an ask", () => {
  test("Esc cancels, Enter sends, digits pick from a single list", () => {
    expect(keyAnswer(ask([select]), press("Escape"), "page")).toEqual({ type: "cancel" });
    expect(keyAnswer(ask([select]), press("Enter"), "band")).toEqual({ type: "submit" });
    expect(keyAnswer(ask([select]), press("2"), "band")).toEqual({ type: "digit", index: 1 });
  });

  test("arrows move a single list from the band, and are the browser's on a focused radio", () => {
    expect(keyAnswer(ask([select]), press("ArrowDown"), "band")).toEqual({
      type: "move",
      delta: 1,
    });
    expect(keyAnswer(ask([select]), press("ArrowUp"), "band")).toEqual({ type: "move", delta: -1 });
    expect(keyAnswer(ask([select]), press("ArrowDown"), "choice")).toBeNull();
    expect(keyAnswer(ask([select]), press("ArrowDown"), "page")).toBeNull();
  });

  test("arrows scroll the focused question instead of moving the choice", () => {
    for (const key of ["ArrowDown", "ArrowUp", "PageDown"]) {
      expect(keyAnswer(ask([select]), press(key), "question")).toBeNull();
    }
    // Esc and Enter still answer from there, like anywhere else in the band.
    expect(keyAnswer(ask([select]), press("Escape"), "question")).toEqual({ type: "cancel" });
    expect(keyAnswer(ask([select]), press("Enter"), "question")).toEqual({ type: "submit" });
  });

  test("digits are typed text while the other box has focus", () => {
    expect(keyAnswer(ask([select]), press("2"), "text")).toBeNull();
  });

  test("a plain yes or no answers with Y and N and leaves Enter to the focused button", () => {
    expect(keyAnswer(ask([confirm]), press("y"), "page")).toEqual({ type: "confirm", value: true });
    expect(keyAnswer(ask([confirm]), press("N"), "page")).toEqual({
      type: "confirm",
      value: false,
    });
    expect(keyAnswer(ask([confirm]), press("Enter"), "page")).toBeNull();
  });
});

describe("where a key landed", () => {
  const el = (tagName: string, extra: object = {}) => ({ tagName, ...extra });
  test.each<[string, ReturnType<typeof el> | null, "band" | "band-self" | "outside", KeyTarget]>([
    ["nothing focused", null, "outside", "page"],
    ["the band itself", el("SECTION"), "band-self", "band"],
    ["a button in the band", el("BUTTON"), "band", "button"],
    ["a radio in the band", el("INPUT", { type: "radio" }), "band", "choice"],
    ["the other box in the band", el("INPUT", { type: "text" }), "band", "text"],
    ["the scrollable question", el("SECTION", { dataset: { question: "" } }), "band", "question"],
    ["a draft in the input bar", el("TEXTAREA", { value: "hi" }), "outside", "foreign"],
    ["an empty input bar", el("TEXTAREA", { value: "" }), "outside", "empty-field"],
    ["a text field elsewhere", el("INPUT", { type: "text" }), "outside", "foreign"],
    ["a button elsewhere", el("BUTTON"), "outside", "button"],
  ])("%s", (_name, element, where, expected) => {
    expect(targetOf(element, where)).toBe(expected);
  });
});

describe("ask draft", () => {
  test("a select starts on its first choice and the answer carries only what was filled", () => {
    const draft = initialDraft([select]);
    expect(draft).toEqual({ q0: "a" });
    expect(draftContent([select], draft)).toEqual({ q0: "a" });
  });

  test("a yes/no box starts unchecked, and that already counts as an answer", () => {
    expect(initialDraft([confirm])).toEqual({ value: false });
    expect(canSend([confirm], initialDraft([confirm]))).toBe(true);
    expect(draftContent([confirm], initialDraft([confirm]))).toEqual({ value: false });
  });

  test("typed other text replaces the choice, as the sidecar reads it", () => {
    const draft = { q0: "a", q0__other: "  c  " };
    expect(draftContent([select], draft)).toEqual({ q0__other: "  c  " });
  });

  test("a required question without an answer cannot be sent; an other text counts", () => {
    expect(canSend([{ ...select, choices: [] }], {})).toBe(false);
    expect(canSend([select], { q0__other: "x" })).toBe(true);
    expect(canSend([{ ...select, required: false }], {})).toBe(true);
  });
});

describe("marks and errors", () => {
  test("a waiting question outranks every other state in the sidebar mark", () => {
    expect(sessionMark("streaming", true)).toBe("approval");
    expect(sessionMark("failed", true)).toBe("approval");
    expect(sessionMark("streaming")).toBe("running");
  });

  test("a stale answer is a sentence, not the IPC text", () => {
    const raw = new Error(
      "Error invoking remote method 'session:answer-permission': Error: stale request: req-1",
    );
    expect(describeError(raw)).toBe("That question is no longer waiting.");
  });

  test.each([
    "not an offered option: allow_once",
    "unknown answer field: extra",
    "answer to q0 must be text",
    "q0 needs an answer",
    "q1 must be true or false",
    "q0 is not one of the offered choices",
    "q2 has a value that was not offered",
    "Error invoking remote method 'session:answer-ask': Error: action is not valid",
    "content is not valid",
  ])("a refused answer (%s) is a sentence, never the internal text", (raw) => {
    expect(describeError(new Error(raw))).toBe(
      "That answer was not accepted. Check it and try again.",
    );
  });
});

describe("the band's key gate", () => {
  const band = { contains: (other: unknown) => other === inside };
  const inside = { tagName: "DIV" };

  test("a key answers only after the grace period of the request it was created for", () => {
    let clock = 5_000;
    const keys = createBandKeys(() => clock);
    const enter = press("Enter");

    expect(keys.answer(permission, enter, null, band)).toBeNull();
    clock += KEY_GRACE_MS - 1;
    expect(keys.answer(permission, enter, null, band)).toBeNull();
    clock += 1;
    expect(keys.answer(permission, enter, null, band)).toEqual({
      type: "option",
      kind: "allow_once",
    });
  });

  test("a second request has its own grace period", () => {
    let clock = 0;
    const first = createBandKeys(() => clock);
    clock = 10_000;
    expect(first.answer(permission, press("Enter"), null, band)).not.toBeNull();

    const second = createBandKeys(() => clock);
    expect(second.answer(permission, press("Enter"), null, band)).toBeNull();
    clock += KEY_GRACE_MS;
    expect(second.answer(permission, press("Enter"), null, band)).not.toBeNull();
  });

  test("where focus is decides the target: the band itself, inside it, or elsewhere", () => {
    let clock = 0;
    const keys = createBandKeys(() => clock);
    clock = KEY_GRACE_MS;
    const late = (...args: Parameters<typeof keys.answer>) => keys.answer(...args);
    // Arrow keys move a single choice only when the band itself has focus.
    expect(late(ask([select]), press("ArrowDown"), band as never, band)).toEqual({
      type: "move",
      delta: 1,
    });
    // A draft in the input bar is not the band's, whatever the clock says.
    expect(late(permission, press("Enter"), { tagName: "TEXTAREA", value: "hi" }, band)).toBeNull();
  });
});
