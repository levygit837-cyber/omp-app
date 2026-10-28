import { describe, expect, test } from "bun:test";
import { MAX_IMAGES_PER_PROMPT } from "@omp-app/protocol";
import {
  type Draft,
  draftAfter,
  joinedText,
  restoreDraft,
  restoredNote,
  takeBackQueued,
  withQueuedText,
} from "../src/renderer/draft";
import type { DraftImage } from "../src/renderer/draft-images";

const image = (id: number): DraftImage => ({
  id,
  name: `i${id}.png`,
  mimeType: "image/png",
  data: "",
  bytes: 1,
});

describe("restoreDraft", () => {
  test("a rejected send gives back its text, files and images ahead of what was typed since", () => {
    const sent = { text: "explain", files: ["a.ts"], images: [image(1)] };
    const current = { text: "and also", files: ["b.ts", "a.ts"], images: [image(2)] };
    expect(restoreDraft(current, sent)).toEqual({
      text: "explain\nand also",
      files: ["a.ts", "b.ts"],
      images: [image(1), image(2)],
    });
  });

  test("an empty bar gets exactly what was sent", () => {
    const sent = { text: "x", files: ["a.ts"], images: [image(1)] };
    expect(restoreDraft({ text: "", files: [], images: [] }, sent)).toEqual(sent);
  });

  test("never more images than a message may carry", () => {
    const many = Array.from({ length: MAX_IMAGES_PER_PROMPT }, (_, i) => image(i));
    const restored = restoreDraft(
      { text: "", files: [], images: [image(99)] },
      {
        text: "",
        files: [],
        images: many,
      },
    );
    expect(restored.images).toHaveLength(MAX_IMAGES_PER_PROMPT);
    expect(restored.images.map((i) => i.id)).toEqual(many.map((i) => i.id));
  });
});

describe("joinedText", () => {
  // omp reads `@` files only for a prompt that starts a turn, so a joined message names the
  // path without the `@` that would promise a read that never happens.
  test("a message that joins a turn carries file paths as plain words", () => {
    expect(joinedText(" look ", ["a.ts", "my docs/b.md"])).toBe("look a.ts my docs/b.md");
    expect(joinedText("", ["a.ts"])).toBe("a.ts");
    expect(joinedText("hi", [])).toBe("hi");
  });
});

describe("draftAfter", () => {
  const typed: Draft = { text: "typing", files: ["a.ts"], images: [image(1)] };

  test("sent empties the bar", () => {
    expect(draftAfter(typed, { type: "sent" })).toEqual({ text: "", files: [], images: [] });
  });

  test("rejected gives back what was sent, ahead of what was typed since", () => {
    const sent: Draft = { text: "explain", files: ["b.ts"], images: [image(2)] };
    expect(draftAfter(typed, { type: "rejected", sent })).toEqual({
      text: "explain\ntyping",
      files: ["b.ts", "a.ts"],
      images: [image(2), image(1)],
    });
  });

  test("stopped puts the messages that came back in front of the text, keeping files and images", () => {
    expect(draftAfter(typed, { type: "stopped", back: ["one", "two"] })).toEqual({
      text: "one\ntwo\ntyping",
      files: ["a.ts"],
      images: [image(1)],
    });
  });

  test("stopped with nothing back leaves the very same draft", () => {
    expect(draftAfter(typed, { type: "stopped", back: [] })).toBe(typed);
  });
});

describe("takeBackQueued", () => {
  const entries = [
    { queue: "steering" as const, text: "s" },
    { queue: "followUp" as const, text: "f1" },
    { queue: "followUp" as const, text: "f2" },
  ];

  test("returns the texts omp gave back, in order, and asks for each by queue and text", async () => {
    const asked: string[] = [];
    const back = await takeBackQueued(entries, async (queue, text) => {
      asked.push(`${queue}:${text}`);
      return true;
    });
    expect(back).toEqual(["s", "f1", "f2"]);
    expect(asked).toEqual(["steering:s", "followUp:f1", "followUp:f2"]);
  });

  test("a removal that says no, or throws, is skipped and the rest still go", async () => {
    const back = await takeBackQueued(entries, async (_queue, text) => {
      if (text === "s") return false;
      if (text === "f1") throw new Error("queue moved");
      return true;
    });
    expect(back).toEqual(["f2"]);
  });

  test("duplicates are asked for one by one, each taking one match", async () => {
    let left = 2;
    const back = await takeBackQueued(
      [
        { queue: "followUp", text: "same" },
        { queue: "followUp", text: "same" },
        { queue: "followUp", text: "same" },
      ],
      async () => left-- > 0,
    );
    expect(back).toEqual(["same", "same"]);
  });
});

describe("queued text coming back", () => {
  test("goes in front of the draft, one message per line", () => {
    expect(withQueuedText("typing", ["one", "two"])).toBe("one\ntwo\ntyping");
    expect(withQueuedText("", ["one"])).toBe("one");
    expect(withQueuedText("typing", [])).toBe("typing");
  });

  test("the note counts what came back", () => {
    expect(restoredNote(1)).toContain("message is back");
    expect(restoredNote(3)).toContain("3 queued messages");
  });

  test("the note says so when a message had to stay queued", () => {
    expect(restoredNote(0, 1)).toMatch(/stays queued/);
    expect(restoredNote(2, 2)).toMatch(/2 queued messages are back.*2 repeat.*stay queued/);
    expect(restoredNote(2, 0)).not.toMatch(/queued and/);
  });
});
