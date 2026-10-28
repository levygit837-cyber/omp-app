import { describe, expect, test } from "bun:test";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_PROMPT, MAX_TOTAL_IMAGE_BYTES } from "@omp-app/protocol";
import {
  deliveryForKey,
  groupByProvider,
  imageProblem,
  imagesRefusal,
  mentionAt,
  mentionToken,
  promptText,
  queueRows,
  restorableOnStop,
  sameMention,
  stuckOnStop,
  thinkingChoices,
  withoutMention,
} from "../src/renderer/prompt-input";

const key = (over: Partial<Parameters<typeof deliveryForKey>[0]> = {}) => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...over,
});

describe("deliveryForKey", () => {
  test("Enter steers, Ctrl or Cmd+Enter queues for after", () => {
    expect(deliveryForKey(key())).toBe("steer");
    expect(deliveryForKey(key({ ctrlKey: true }))).toBe("followUp");
    expect(deliveryForKey(key({ metaKey: true }))).toBe("followUp");
  });

  test("Shift+Enter, an IME confirmation and other keys send nothing", () => {
    expect(deliveryForKey(key({ shiftKey: true }))).toBeNull();
    expect(deliveryForKey(key({ isComposing: true }))).toBeNull();
    expect(deliveryForKey(key({ key: "a" }))).toBeNull();
  });
});

describe("sameMention", () => {
  // Esc closes the list while the caret stays put, and the selection event that follows reads
  // the same reference again: this is what keeps it closed until the reference changes.
  test("the same reference read twice is the same; a longer query or another @ is not", () => {
    const a = mentionAt("see @sr", 7);
    expect(sameMention(a, mentionAt("see @sr", 7))).toBe(true);
    expect(sameMention(a, mentionAt("see @src", 8))).toBe(false);
    expect(sameMention(a, mentionAt("see @sr and @sr", 15))).toBe(false);
    expect(sameMention(a, null)).toBe(false);
    expect(sameMention(null, null)).toBe(false);
  });
});

describe("mentionAt", () => {
  test("finds the reference under the caret", () => {
    expect(mentionAt("read @src/ma", 12)).toEqual({ start: 5, end: 12, query: "src/ma" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  test("an @ inside a word (an e-mail) or after a finished reference is not one", () => {
    expect(mentionAt("mail me@host", 12)).toBeNull();
    expect(mentionAt("read @a.ts then", 15)).toBeNull();
    expect(mentionAt("no at sign", 5)).toBeNull();
  });

  test("withoutMention cuts the reference out and puts the caret where it was", () => {
    const mention = mentionAt("read @src/ma now", 12);
    if (!mention) throw new Error("expected a mention");
    expect(withoutMention("read @src/ma now", mention)).toEqual({ text: "read  now", caret: 5 });
  });
});

describe("file references in the prompt", () => {
  test("a path with a space is quoted, one with a quote cannot be carried", () => {
    expect(mentionToken("src/a.ts")).toBe("@src/a.ts");
    expect(mentionToken("my docs/a.md")).toBe('@"my docs/a.md"');
    expect(mentionToken('we"ird.ts')).toBeNull();
  });

  test("promptText appends the chosen files to what was typed", () => {
    expect(promptText("  explain  ", ["a.ts", "my docs/b.md"])).toBe(
      'explain @a.ts @"my docs/b.md"',
    );
    expect(promptText("", ["a.ts"])).toBe("@a.ts");
    expect(promptText("   ", [])).toBe("");
  });
});

describe("queueRows", () => {
  test("steering first, then follow-ups; an entry already sent into the response cannot be removed", () => {
    const rows = queueRows({ steering: ["s1", "s2"], followUp: ["f1"], liveSteered: 1 });
    expect(rows.map((r) => [r.queue, r.text, r.removable])).toEqual([
      ["steering", "s1", false],
      ["steering", "s2", true],
      ["followUp", "f1", true],
    ]);
  });

  test("two entries with the same text keep distinct keys", () => {
    const rows = queueRows({ steering: ["x", "x"], followUp: ["x"], liveSteered: 0 });
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  // omp removes by text and takes the first match (`#findQueuedUserMessage`), so a later
  // duplicate has no button: pressing it would remove the earlier one under the wrong row.
  test("only the first of several entries with the same text can be removed", () => {
    const rows = queueRows({ steering: [], followUp: ["again", "other", "again"], liveSteered: 0 });
    expect(rows.map((r) => r.removable)).toEqual([true, true, false]);
  });
});

describe("restorableOnStop", () => {
  test("takes back every follow-up and the steers not yet sent, oldest first", () => {
    const back = restorableOnStop({
      steering: ["sent", "s2"],
      followUp: ["f1", "f2"],
      liveSteered: 1,
    });
    expect(back).toEqual([
      { queue: "steering", text: "s2" },
      { queue: "followUp", text: "f1" },
      { queue: "followUp", text: "f2" },
    ]);
  });

  test("leaves a steer whose text equals one already sent, since removal could match the sent one", () => {
    const back = restorableOnStop({ steering: ["same", "same"], followUp: [], liveSteered: 1 });
    expect(back).toEqual([]);
  });

  test("an empty queue gives nothing", () => {
    expect(restorableOnStop({ steering: [], followUp: [], liveSteered: 0 })).toEqual([]);
  });
});

describe("stuckOnStop", () => {
  test("lists the steers Stop must leave, the ones that repeat a steer already sent", () => {
    expect(
      stuckOnStop({ steering: ["same", "same", "other"], followUp: [], liveSteered: 1 }),
    ).toEqual([{ queue: "steering", text: "same" }]);
  });

  test("is exactly what restorableOnStop leaves out, so the two never drop or double a message", () => {
    const queue = { steering: ["a", "a", "b", "c"], followUp: ["a", "d"], liveSteered: 2 };
    const taken = restorableOnStop(queue).map((e) => `${e.queue}:${e.text}`);
    const stuck = stuckOnStop(queue).map((e) => `${e.queue}:${e.text}`);
    const waiting = [
      ...queue.steering.slice(queue.liveSteered).map((t) => `steering:${t}`),
      ...queue.followUp.map((t) => `followUp:${t}`),
    ];
    expect([...taken, ...stuck].sort()).toEqual([...waiting].sort());
  });

  test("an empty queue, or one with nothing sent yet, leaves nothing", () => {
    expect(stuckOnStop({ steering: [], followUp: [], liveSteered: 0 })).toEqual([]);
    expect(stuckOnStop({ steering: ["a", "a"], followUp: [], liveSteered: 0 })).toEqual([]);
  });
});

describe("imagesRefusal", () => {
  // omp lists an image-only follow-up as "[Image]" and cannot give the bytes back on Stop.
  test("images are refused while a turn runs, with a sentence, and accepted otherwise", () => {
    expect(imagesRefusal(true)).toBe("Images can be attached when the turn ends.");
    expect(imagesRefusal(false)).toBeNull();
  });
});

describe("models", () => {
  const model = (provider: string, name: string, efforts: string[] = []) => ({
    id: `${provider}/${name}`,
    provider,
    name,
    efforts,
  });

  test("groupByProvider orders providers and their models by name", () => {
    const groups = groupByProvider([
      model("openai", "b"),
      model("anthropic", "z"),
      model("openai", "a"),
    ]);
    expect(groups.map((g) => [g.provider, g.models.map((m) => m.name)])).toEqual([
      ["anthropic", ["z"]],
      ["openai", ["a", "b"]],
    ]);
  });

  test("a model without efforts offers no thinking control; others offer off, auto and theirs", () => {
    expect(thinkingChoices(undefined)).toEqual([]);
    expect(thinkingChoices(model("p", "plain"))).toEqual([]);
    expect(thinkingChoices(model("p", "deep", ["low", "high"]))).toEqual([
      "off",
      "auto",
      "low",
      "high",
    ]);
  });
});

describe("imageProblem", () => {
  const ok = { type: "image/png", size: 1000 };

  test("accepts an allowed image", () => {
    expect(imageProblem(ok, 0)).toBeNull();
  });

  test("names the reason for each refusal", () => {
    expect(imageProblem({ type: "image/svg+xml", size: 10 }, 0)).toContain("PNG");
    expect(imageProblem({ type: "application/pdf", size: 10 }, 0)).toContain("images");
    expect(imageProblem({ ...ok, size: MAX_IMAGE_BYTES + 1 }, 0)).toContain("limit");
    expect(imageProblem(ok, MAX_IMAGES_PER_PROMPT)).toContain(String(MAX_IMAGES_PER_PROMPT));
  });

  test("refuses an image that pushes the attached bytes past the total limit", () => {
    const big = { type: "image/png", size: MAX_IMAGE_BYTES };
    expect(imageProblem(big, 1, MAX_TOTAL_IMAGE_BYTES - MAX_IMAGE_BYTES)).toBeNull();
    expect(imageProblem(big, 1, MAX_TOTAL_IMAGE_BYTES - MAX_IMAGE_BYTES + 1)).toContain("16");
  });
});
