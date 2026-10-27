import { describe, expect, test } from "bun:test";
import { isValidElement } from "react";
import type { MarkdownProps } from "../src/markdown";
import { Plain, resolveMarkdown } from "../src/markdown-lazy";

const Markdown = () => null;
const props: MarkdownProps = { text: "a **reply**\nwith two lines" };

describe("resolveMarkdown", () => {
  test("a chunk that fails to load resolves to plain text, it does not reject", async () => {
    const failed = Promise.reject(new Error("Failed to fetch dynamically imported module"));
    const { default: Component } = await resolveMarkdown(failed);
    expect(Component).toBe(Plain);
    const element = Component(props);
    expect(isValidElement(element)).toBe(true);
    expect((element as { type: unknown }).type).toBe("p");
    expect((element as { props: { children: unknown } }).props.children).toBe(props.text);
  });

  test("a chunk that loads is the markdown component", async () => {
    const { default: Component } = await resolveMarkdown(Promise.resolve({ Markdown }));
    expect(Component).toBe(Markdown);
  });
});
