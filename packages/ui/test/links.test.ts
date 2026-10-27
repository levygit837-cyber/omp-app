import { describe, expect, test } from "bun:test";
import { safeLinkUrl } from "../src/links";

describe("safeLinkUrl", () => {
  test.each([
    ["http://example.com/a?b=1", "http"],
    ["https://example.com", "https"],
    ["HTTPS://Example.com/x", "https"],
    ["  https://example.com  ", "https"],
    ["mailto:a@b.co", "mailto"],
    ["MAILTO:a@b.co", "mailto"],
  ])("allows %s", (input, scheme) => {
    expect(safeLinkUrl(input)?.scheme).toBe(scheme as never);
  });

  test.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " \u0001javascript:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<b>x</b>",
    "file:///etc/passwd",
    "//evil.example/x",
    "http:\\\\evil.example",
    "http:/evil.example",
    "https://",
    "/relative/path",
    "./a",
    "#anchor",
    "vbscript:x",
    "",
    "   ",
    "https://exa\nmple.com",
    "mailto:",
  ])("rejects %j", (input) => {
    expect(safeLinkUrl(input)).toBeNull();
  });

  test("normalises the href", () => {
    expect(safeLinkUrl("HTTPS://Example.com")?.href).toBe("https://example.com/");
  });
});
