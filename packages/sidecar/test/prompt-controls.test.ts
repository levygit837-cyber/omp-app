import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_QUERY_CHARS, MAX_IMAGES_PER_PROMPT } from "@omp-app/protocol";
import { emptyViewModel } from "../src/reducer";
import { type SessionControl, sessionHandlers } from "../src/session-handlers";
import { SessionStore } from "../src/session-store";
import { noPromptControls } from "./harness";
import { PNG_HEAD } from "./images";

const client = { emit: () => {} };
const noRequests = { answerPermission() {}, answerAsk() {}, dismissSession() {} };

/** A control that records what the handlers asked of omp. */
function setup(over: Partial<SessionControl> = {}) {
  const calls: string[] = [];
  const store = new SessionStore();
  store.create(emptyViewModel({ id: "s1", cwd: "/work", model: "p/m" }));
  const control: SessionControl = {
    ...noPromptControls,
    list: async () => [],
    createSession: async () => "s1",
    resumeSession: async (id) => id,
    forkSession: async (id) => id,
    closeSession: async () => {},
    cancel: async () => {},
    prompt: async (_id, text, images) => {
      calls.push(`prompt:${text}:${images?.length ?? 0}`);
      return "end_turn";
    },
    join: async (_id, text, _images, delivery) => {
      calls.push(`join:${delivery}:${text}`);
      return true;
    },
    ...over,
  };
  const handlers = sessionHandlers(control, store, noRequests);
  return { calls, store, handlers };
}

const png = { mimeType: "image/png", data: PNG_HEAD };

describe("session.prompt", () => {
  test("an idle session starts a turn, whatever the delivery says", async () => {
    const { calls, handlers } = setup();
    await handlers["session.prompt"]({ sessionId: "s1", text: "go", delivery: "followUp" }, client);
    expect(calls).toEqual(["prompt:go:0"]);
  });

  test("a running turn is joined: a steer by default, a follow-up when asked", async () => {
    const { calls, store, handlers } = setup();
    store.dispatch("s1", { type: "agent_start" });
    await handlers["session.prompt"]({ sessionId: "s1", text: "a" }, client);
    await handlers["session.prompt"]({ sessionId: "s1", text: "b", delivery: "followUp" }, client);
    expect(calls).toEqual(["join:steer:a", "join:followUp:b"]);
  });

  test("when omp declines to join, the prompt starts a turn instead of being lost", async () => {
    const { calls, store, handlers } = setup({ join: async () => false });
    store.dispatch("s1", { type: "agent_start" });
    await handlers["session.prompt"]({ sessionId: "s1", text: "late" }, client);
    expect(calls).toEqual(["prompt:late:0"]);
  });

  test("images reach omp", async () => {
    const { calls, handlers } = setup();
    await handlers["session.prompt"]({ sessionId: "s1", text: "see", images: [png] }, client);
    expect(calls).toEqual(["prompt:see:1"]);
  });

  test("refuses images by reason before anything reaches omp", async () => {
    const { calls, handlers } = setup();
    const send = (images: unknown) =>
      handlers["session.prompt"]({ sessionId: "s1", text: "x", images: images as never }, client);
    await expect(send([{ mimeType: "image/svg+xml", data: "AAAA" }])).rejects.toThrow(
      "image refused: type",
    );
    await expect(send([{ mimeType: "image/png", data: "no!" }])).rejects.toThrow(
      "image refused: corrupt",
    );
    await expect(
      send(Array.from({ length: MAX_IMAGES_PER_PROMPT + 1 }, () => png)),
    ).rejects.toThrow("image refused: count");
    await expect(send("not a list")).rejects.toThrow("invalid prompt");
    await expect(send([{ mimeType: 3 }])).rejects.toThrow("invalid prompt");
    expect(calls).toEqual([]);
  });

  test("refuses a delivery that is neither steer nor follow-up", async () => {
    const { calls, handlers } = setup();
    await expect(
      handlers["session.prompt"]({ sessionId: "s1", text: "x", delivery: "now" as never }, client),
    ).rejects.toThrow("invalid prompt");
    expect(calls).toEqual([]);
  });

  test("an unknown session is a clear error, not a turn", async () => {
    const { calls, handlers } = setup();
    await expect(
      handlers["session.prompt"]({ sessionId: "gone", text: "x" }, client),
    ).rejects.toThrow("gone");
    expect(calls).toEqual([]);
  });
});

describe("model, thinking and queue", () => {
  test("setModel and setThinking pass the choice through and check its type", async () => {
    const seen: string[] = [];
    const { handlers } = setup({
      setModel: async (_id, model) => void seen.push(`model:${model}`),
      setThinking: (_id, level) => void seen.push(`level:${level}`),
    });
    await handlers["session.setModel"]({ sessionId: "s1", model: "p/m" }, client);
    await handlers["session.setThinking"]({ sessionId: "s1", level: "high" }, client);
    await expect(
      handlers["session.setModel"]({ sessionId: "s1", model: 3 as never }, client),
    ).rejects.toThrow("invalid model");
    await expect(
      handlers["session.setThinking"]({ sessionId: "s1", level: null as never }, client),
    ).rejects.toThrow("invalid thinking level");
    expect(seen).toEqual(["model:p/m", "level:high"]);
  });

  test("removeQueued reports whether omp still held the entry, and refuses an unknown queue", async () => {
    const asked: string[] = [];
    const { handlers } = setup({
      removeQueued: (_id, queue, text) => {
        asked.push(`${queue}:${text}`);
        return text === "held";
      },
    });
    expect(
      await handlers["session.removeQueued"](
        { sessionId: "s1", queue: "followUp", text: "held" },
        client,
      ),
    ).toEqual({
      removed: true,
    });
    expect(
      await handlers["session.removeQueued"](
        { sessionId: "s1", queue: "steering", text: "gone" },
        client,
      ),
    ).toEqual({
      removed: false,
    });
    await expect(
      handlers["session.removeQueued"](
        { sessionId: "s1", queue: "other" as never, text: "x" },
        client,
      ),
    ).rejects.toThrow("invalid queue entry");
    expect(asked).toEqual(["followUp:held", "steering:gone"]);
  });
});

describe("session.files", () => {
  test("lists the files of the session folder and refuses an oversized query", async () => {
    const root = mkdtempSync(join(tmpdir(), "files-handler-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "app.ts"), "");
      const { handlers } = setup({ cwdOf: () => root });
      expect(await handlers["session.files"]({ sessionId: "s1", query: "app" }, client)).toEqual({
        files: ["src/app.ts"],
        truncated: false,
      });
      await expect(
        handlers["session.files"](
          { sessionId: "s1", query: "x".repeat(MAX_FILE_QUERY_CHARS + 1) },
          client,
        ),
      ).rejects.toThrow("invalid query");
      await expect(
        handlers["session.files"]({ sessionId: "s1", query: 3 as never }, client),
      ).rejects.toThrow("invalid query");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
