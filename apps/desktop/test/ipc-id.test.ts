import { describe, expect, test } from "bun:test";
import { ipcId, MAX_ID_LENGTH } from "../src/main/ipc-id";

describe("an id from the renderer", () => {
  test("is returned as given when it is a string within the bound", () => {
    expect(ipcId("a".repeat(MAX_ID_LENGTH), "subagentId")).toBe("a".repeat(MAX_ID_LENGTH));
    expect(ipcId("view:parent:sub-1", "subagentId")).toBe("view:parent:sub-1");
  });

  test.each([
    ["empty", ""],
    ["a number", 7],
    ["an object", { toString: () => "x" }],
    ["undefined", undefined],
    ["longer than the bound", "a".repeat(MAX_ID_LENGTH + 1)],
  ])("is refused when it is %s", (_name, value) => {
    expect(() => ipcId(value, "jobId")).toThrow();
  });
});
