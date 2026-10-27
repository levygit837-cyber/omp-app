import { describe, expect, test } from "bun:test";
import { NONE, type OpenSessions } from "../src/renderer/open-sessions";
import { type ActionApi, type Held, perform } from "../src/renderer/session-actions";

const set = (open: string[], focused: string | null): OpenSessions => ({ open, focused });
const held = (sessions: OpenSessions): Held => ({ sessions, lost: false, error: null });

/** A sidecar double: every method succeeds unless `fail` names it. */
function api(fail: Partial<Record<keyof ActionApi, string>> = {}): ActionApi & { calls: string[] } {
  const calls: string[] = [];
  const step =
    <T>(name: keyof ActionApi, value: T) =>
    async (arg?: string) => {
      calls.push(`${name}:${arg ?? ""}`);
      const message = fail[name];
      if (message) throw new Error(message);
      return value;
    };
  return {
    calls,
    create: step("create", "new-id"),
    resume: step("resume", "resumed-id"),
    fork: step("fork", "fork-id"),
    close: step("close", undefined),
    attach: async (id) => {
      calls.push(`attach:${id}`);
      return id;
    },
    detach: step("detach", undefined),
  } as ActionApi & { calls: string[] };
}

describe("a failed action leaves a visible error and everything else as it was", () => {
  test("a failing resume while a session is focused", async () => {
    const before = held(set(["a"], "a"));
    const patch = await perform(
      api({
        resume: "Error invoking remote method 'session:resume': Error: session not found: 7f3c",
      }),
      before.sessions,
      { action: "resume", sessionId: "gone" },
    );
    const after = patch(before);
    expect(after.sessions).toEqual(set(["a"], "a"));
    expect(after.error).toMatchObject({ action: "resume", title: "Couldn’t open that session" });
    // A sentence, never the raw text or the id.
    expect(after.error?.message).toBe("That session is no longer on disk.");
  });

  test("a missing folder names the folder", async () => {
    const patch = await perform(api({ resume: "folder no longer exists: /gone/place" }), NONE, {
      action: "resume",
      sessionId: "x",
    });
    expect(patch(held(NONE)).error?.message).toContain("/gone/place");
  });

  test("each action names its own failure", async () => {
    const title = async (action: "fork" | "close", key: "fork" | "close") =>
      (await perform(api({ [key]: "boom" }), set(["a"], "a"), { action, sessionId: "a" }))(
        held(set(["a"], "a")),
      ).error?.title;
    expect(await title("fork", "fork")).toBe("Couldn’t fork that session");
    expect(await title("close", "close")).toBe("Couldn’t close that session");
    const created = await perform(api({ create: "boom" }), NONE, { action: "new", cwd: "/p" });
    expect(created(held(NONE)).error?.title).toBe("Couldn’t start a session");
  });

  test("a refused close keeps the session open and attached", async () => {
    const fake = api({ close: "boom" });
    const patch = await perform(fake, set(["a"], "a"), { action: "close", sessionId: "a" });
    expect(patch(held(set(["a"], "a"))).sessions).toEqual(set(["a"], "a"));
    expect(fake.calls).not.toContain("detach:a");
  });
});

describe("a successful action", () => {
  test("opens and focuses the session under the id the replica ended up with, clearing an old error", async () => {
    const fake = api();
    fake.attach = async () => "moved";
    const patch = await perform(fake, set(["a"], "a"), { action: "resume", sessionId: "x" });
    const before: Held = {
      ...held(set(["a"], "a")),
      error: { action: "fork", title: "t", message: "m" },
    };
    const after = patch(before);
    expect(after.sessions).toEqual(set(["a", "moved"], "moved"));
    expect(after.error).toBeNull();
  });

  test("resuming an open session only focuses it", async () => {
    const fake = api();
    const patch = await perform(fake, set(["a", "b"], "a"), { action: "resume", sessionId: "b" });
    expect(patch(held(set(["a", "b"], "a"))).sessions).toEqual(set(["a", "b"], "b"));
    expect(fake.calls).toEqual([]);
  });

  test("the outcome applies to the state as it is when the action ends, not when it began", async () => {
    const patch = await perform(api(), set(["a"], "a"), { action: "fork", sessionId: "a" });
    // Another session was opened while the fork ran.
    const later = held(set(["a", "other"], "other"));
    expect(patch(later).sessions).toEqual(set(["a", "other", "fork-id"], "fork-id"));
  });

  test("close detaches, then removes it from the open set", async () => {
    const fake = api();
    const patch = await perform(fake, set(["a", "b"], "a"), { action: "close", sessionId: "a" });
    expect(patch(held(set(["a", "b"], "a"))).sessions).toEqual(set(["b"], "b"));
    expect(fake.calls).toEqual(["close:a", "detach:a"]);
  });
});
