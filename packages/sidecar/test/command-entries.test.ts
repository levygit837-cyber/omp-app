import { expect, test } from "bun:test";
import { COMMAND_OUTPUT_MAX } from "@omp-app/protocol";
import { clampOutput } from "../src/command-entries";

test("a cut that falls between the halves of a surrogate pair backs off one code unit", () => {
  const output = `${"a".repeat(COMMAND_OUTPUT_MAX - 1)}😀tail`;
  const cut = clampOutput(output);
  expect(cut.truncated).toBe(true);
  expect(cut.output).toBe("a".repeat(COMMAND_OUTPUT_MAX - 1));
  // No lone half is left behind.
  expect(/[\ud800-\udbff]$/.test(cut.output)).toBe(false);
});

test("output within the limit is left alone, and one cut on a whole character is not shortened", () => {
  expect(clampOutput("short")).toEqual({ output: "short", truncated: false });
  const output = "a".repeat(COMMAND_OUTPUT_MAX + 5);
  expect(clampOutput(output)).toEqual({
    output: "a".repeat(COMMAND_OUTPUT_MAX),
    truncated: true,
  });
});
