import { describe, expect, test } from "bun:test";
import { scrollClosesCard } from "../src/confirm-scroll";

/** A node of a tiny tree; like `Node.contains`, a node contains itself. */
class N {
  constructor(readonly parent?: N) {}
  contains(other: N): boolean {
    for (let at: N | undefined = other; at; at = at.parent) if (at === this) return true;
    return false;
  }
}

const page = new N();
const sidebar = new N(page);
const opener = new N(sidebar);
const timeline = new N(page);

describe("a scroll while a confirm card is open", () => {
  test("closes it when the scrolled element holds the opener", () => {
    expect(scrollClosesCard(sidebar, opener)).toBe(true);
    expect(scrollClosesCard(page, opener)).toBe(true);
    expect(scrollClosesCard(opener, opener)).toBe(true);
  });

  test("leaves it open when the scrolled element is elsewhere or inside the opener", () => {
    expect(scrollClosesCard(timeline, opener)).toBe(false);
    expect(scrollClosesCard(new N(opener), opener)).toBe(false);
    expect(scrollClosesCard(null, opener)).toBe(false);
  });

  test("closes on any scroll when there is no opener to compare against", () => {
    expect(scrollClosesCard(timeline, null)).toBe(true);
    expect(scrollClosesCard(null, undefined)).toBe(true);
  });
});
