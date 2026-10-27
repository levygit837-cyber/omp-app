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
});
