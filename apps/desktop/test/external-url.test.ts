import { describe, expect, test } from "bun:test";
import { externalUrl } from "../src/main/external-url";

describe("externalUrl", () => {
  test("accepts http and https addresses", () => {
    expect(externalUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(externalUrl("http://localhost:5173")).toBe("http://localhost:5173/");
  });

  test.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>1</script>",
    "mailto:a@b.c",
    "ssh://host",
    "//example.com",
    "example.com",
    "https://user:pw@example.com",
    "java\nscript:alert(1)",
    "https://example.com/ a",
    "",
  ])("refuses %p", (value) => {
    expect(externalUrl(value)).toBeNull();
  });

  test("refuses anything that is not a string", () => {
    expect(externalUrl(undefined)).toBeNull();
    expect(externalUrl({ href: "https://example.com" })).toBeNull();
    expect(externalUrl(`https://example.com/${"a".repeat(3000)}`)).toBeNull();
  });
});
