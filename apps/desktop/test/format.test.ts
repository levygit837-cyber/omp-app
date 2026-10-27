import { describe, expect, test } from "bun:test";
import {
  clock,
  modelLabel,
  NEW_SESSION_TITLE,
  projectName,
  sessionMark,
  sessionTitle,
} from "../src/renderer/format";

describe("format", () => {
  test("projectName is the folder's basename, tolerating trailing separators and roots", () => {
    expect(projectName("/Users/levy/Projects/omp-app")).toBe("omp-app");
    expect(projectName("/Users/levy/Projects/omp-app/")).toBe("omp-app");
    expect(projectName("C:\\work\\omp-app")).toBe("omp-app");
    expect(projectName("/")).toBe("/");
  });

  test("sessionTitle is the first line of the first prompt, shortened, else 'New session'", () => {
    expect(sessionTitle(undefined)).toBe(NEW_SESSION_TITLE);
    expect(sessionTitle("  \n ")).toBe(NEW_SESSION_TITLE);
    expect(sessionTitle("Fix the flaky   test\nand more")).toBe("Fix the flaky test");
    const long = sessionTitle("x".repeat(100));
    expect(long.length).toBe(48);
    expect(long.endsWith("…")).toBe(true);
  });

  test("sessionTitle never cuts an emoji in half", () => {
    const title = sessionTitle(`${"a".repeat(46)}😀 tail`);
    expect(title).toBe(`${"a".repeat(46)}😀…`);
    expect(title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(Array.from(title).length).toBe(48);
  });

  // The budget is 47 clusters plus the ellipsis. A cluster that ends exactly at the budget stays;
  // one that starts past it goes whole. Neither may leave half of itself behind (cutting by code
  // point would keep the first regional indicator of a flag, or a letter without its accent).
  const titleWith = (text: string, before: number) =>
    sessionTitle(`${"a".repeat(before)}${text}${"b".repeat(10)}`);

  test.each([
    ["a flag", "🇧🇷"],
    ["a ZWJ family", "👨‍👩‍👧‍👦"],
    ["a letter with a combining mark", "e\u0301"],
  ])("sessionTitle keeps %s whole at the cut", (_name, text) => {
    expect(titleWith(text, 46)).toBe(`${"a".repeat(46)}${text}…`);
  });

  test.each([
    ["a flag", "🇧🇷"],
    ["a ZWJ family", "👨‍👩‍👧‍👦"],
    ["a letter with a combining mark", "e\u0301"],
  ])("sessionTitle drops %s whole when it starts past the budget", (_name, text) => {
    expect(titleWith(text, 47)).toBe(`${"a".repeat(47)}…`);
  });

  test("modelLabel drops the provider", () => {
    expect(modelLabel("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelLabel("local")).toBe("local");
    expect(modelLabel(null)).toBeNull();
  });

  test("clock is m:ss and never negative", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(96_000)).toBe("1:36");
    expect(clock(-5)).toBe("0:00");
  });

  test("sessionMark maps the session status onto the shared marks", () => {
    expect(sessionMark("streaming")).toBe("running");
    expect(sessionMark("failed")).toBe("error");
    expect(sessionMark("idle")).toBe("idle");
    expect(sessionMark(undefined)).toBe("idle");
  });
});
