import { expect, test } from "bun:test";
import { LogTail } from "../src/main/log-tail";

test("keeps only the last lines and reassembles lines split across chunks", () => {
  const tail = new LogTail(3);
  tail.push("a\nb\nc");
  tail.push("c\nd\ne\n");
  expect(tail.lines()).toEqual(["cc", "d", "e"]);
});

test("exposes an unterminated trailing line and strips CR", () => {
  const tail = new LogTail(5);
  tail.push("one\r\ntwo");
  expect(tail.lines()).toEqual(["one", "two"]);
});
