import { describe, expect, test } from "bun:test";
import { attachmentsOf, isFileMention, mentionedFiles, thinkingOf } from "../src/user-message";

describe("attachmentsOf", () => {
  test("describes each image by type and decoded size, never by its bytes", () => {
    const content = [
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "image", mimeType: "image/jpeg", data: "AAAAAA==" },
    ];
    expect(attachmentsOf(content)).toEqual([
      { kind: "image", mimeType: "image/png", bytes: 3 },
      { kind: "image", mimeType: "image/jpeg", bytes: 4 },
    ]);
  });

  test("plain text and malformed content carry no attachments", () => {
    expect(attachmentsOf("hello")).toEqual([]);
    expect(attachmentsOf([{ type: "image" }, null, 3])).toEqual([]);
  });
});

describe("mentionedFiles", () => {
  test("lists the paths omp read and leaves the ones it skipped", () => {
    const message = {
      role: "fileMention",
      files: [
        { path: "a.ts", content: "x" },
        { path: "huge.bin", content: "", skippedReason: "binary" },
        { content: "no path" },
        null,
      ],
    };
    expect(isFileMention(message)).toBe(true);
    expect(mentionedFiles(message)).toEqual(["a.ts"]);
  });

  test("a message that is not a file mention, or has malformed files, gives nothing", () => {
    expect(isFileMention({ role: "user" })).toBe(false);
    expect(isFileMention(null)).toBe(false);
    expect(mentionedFiles({ files: "a.ts" })).toEqual([]);
    expect(mentionedFiles({})).toEqual([]);
  });
});

describe("thinkingOf", () => {
  test("the configured level wins over the resolved one", () => {
    expect(thinkingOf("high", "auto")).toBe("auto");
    expect(thinkingOf("high", undefined)).toBe("high");
  });

  test("inherit reads as off and no level at all as none", () => {
    expect(thinkingOf("inherit", undefined)).toBe("off");
    expect(thinkingOf(undefined, undefined)).toBeNull();
  });
});
