import { describe, expect, test } from "bun:test";
import type { Tokens } from "marked";
import { decodeEntities } from "../src/entities";
import { canHighlight } from "../src/highlight-loader";
import { mergeSpans, tokenKind } from "../src/highlight-spans";
import { headingSize, isOpenFence, listMarker, splitBlocks } from "../src/markdown-model";

describe("splitBlocks", () => {
  test("drops blank space and keeps raw per block", () => {
    const b = splitBlocks("# T\n\npara\n\n- a\n- b\n");
    expect(b.map((x) => x.token.type)).toEqual(["heading", "paragraph", "list"]);
  });

  test("a finished block keeps the same raw while the tail grows", () => {
    const a = splitBlocks("first para\n\nsecond");
    const b = splitBlocks("first para\n\nsecond grows");
    expect(a[0]?.raw).toBe(b[0]?.raw);
    expect(a[1]?.raw).not.toBe(b[1]?.raw);
  });

  test("an unterminated fence is one code block", () => {
    const b = splitBlocks("intro\n\n```ts\nconst a = 1;\nfoo");
    expect(b[1]?.token.type).toBe("code");
    expect((b[1]?.token as Tokens.Code | undefined)?.text).toBe("const a = 1;\nfoo");
    expect(isOpenFence(b[1]?.raw ?? "")).toBe(true);
  });

  test("raw html stays a text-bearing html token", () => {
    const b = splitBlocks("<script>alert(1)</script>");
    expect(b[0]?.token.type).toBe("html");
  });
});

describe("isOpenFence", () => {
  test("closed fences", () => {
    expect(isOpenFence("```ts\nx\n```")).toBe(false);
    expect(isOpenFence("~~~\nx\n~~~\n")).toBe(false);
    expect(isOpenFence("````\nx\n```\n````")).toBe(false);
  });
  test("open fences", () => {
    expect(isOpenFence("```ts")).toBe(true);
    expect(isOpenFence("```ts\nx")).toBe(true);
    expect(isOpenFence("````\nx\n```")).toBe(true);
  });
  test("indented code is never open", () => {
    expect(isOpenFence("    code")).toBe(false);
  });
});

describe("listMarker", () => {
  const list = (ordered: boolean, start: number | ""): Tokens.List =>
    ({ type: "list", raw: "", ordered, start, loose: false, items: [] }) as Tokens.List;
  const item = (task: boolean, checked?: boolean) => ({ task, checked }) as Tokens.ListItem;

  test("bullet is an en dash", () => {
    expect(listMarker(list(false, ""), item(false), 0).glyph).toBe("–");
  });
  test("ordered keeps its numbers from start", () => {
    expect(listMarker(list(true, 3), item(false), 2).glyph).toBe("5.");
  });
  test("task items are glyphs with a label, not checkboxes", () => {
    expect(listMarker(list(false, ""), item(true, true), 0)).toEqual({ glyph: "●", label: "done" });
    expect(listMarker(list(false, ""), item(true, false), 0)).toEqual({
      glyph: "○",
      label: "to do",
    });
  });
});

test("headingSize steps once", () => {
  expect([1, 2, 3, 6].map(headingSize)).toEqual(["lg", "lg", "body", "body"]);
});

describe("decodeEntities", () => {
  test("named and numeric", () => {
    expect(decodeEntities("a &amp; b &lt;x&gt; &#39;q&#x27; &unknown;")).toBe(
      "a & b <x> 'q' &unknown;",
    );
  });
  test("invalid code points become the replacement character", () => {
    expect(decodeEntities("&#0; &#xD800; &#99999999;")).toBe("\ufffd \ufffd &#99999999;");
  });
});

describe("highlight spans", () => {
  test("tokenKind maps highlight.js classes", () => {
    expect(tokenKind(["hljs-keyword"])).toBe("keyword");
    expect(tokenKind(["hljs-title", "hljs-function"])).toBeNull();
    expect(tokenKind(["language-ts", "hljs-string"])).toBe("string");
  });
  test("mergeSpans joins neighbours and drops empties", () => {
    expect(
      mergeSpans([
        { text: "a", kind: null },
        { text: "", kind: "string" },
        { text: "b", kind: null },
        { text: "c", kind: "number" },
      ]),
    ).toEqual([
      { text: "ab", kind: null },
      { text: "c", kind: "number" },
    ]);
  });
});

describe("canHighlight", () => {
  test("bounds", () => {
    expect(canHighlight("a\n".repeat(100))).toBe(true);
    expect(canHighlight("\n".repeat(2000))).toBe(false);
    expect(canHighlight("x".repeat(200_001))).toBe(false);
  });
});
