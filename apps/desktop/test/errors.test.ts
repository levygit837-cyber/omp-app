import { describe, expect, test } from "bun:test";
import { describeError } from "../src/renderer/errors";

describe("describeError", () => {
  test("a dead sidecar becomes a sentence, not the IPC text", () => {
    const raw = new Error(
      "Error invoking remote method 'session:cancel': Error: the sidecar is not ready",
    );
    const text = describeError(raw);
    expect(text).not.toContain("remote method");
    expect(text).not.toContain("session:cancel");
  });

  test("other errors lose the IPC prefix and keep their message", () => {
    const raw = new Error(
      "Error invoking remote method 'session:create': Error: no such directory",
    );
    expect(describeError(raw)).toBe("no such directory");
  });

  test("anything else is shown as text, and an empty message is never blank", () => {
    expect(describeError("plain")).toBe("plain");
    expect(describeError(new Error(""))).not.toBe("");
  });

  test("what the sidecar and omp say becomes a sentence, never the raw text", () => {
    const via = (text: string) =>
      describeError(new Error(`Error invoking remote method 'session:resume': Error: ${text}`));
    expect(via("session not found: 7f3c-uuid")).not.toContain("7f3c");
    expect(via("folder no longer exists: /gone")).toContain("/gone");
    expect(via("Could not restore model openai/gpt-x")).toContain("openai/gpt-x");
    expect(via("unknown session: abc")).not.toContain("abc");
    expect(via("ACP session fork is unavailable while a prompt is in progress: abc")).not.toContain(
      "abc",
    );
  });
});
