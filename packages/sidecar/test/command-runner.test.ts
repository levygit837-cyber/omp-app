import { expect, test } from "bun:test";
import { COMMAND_OUTPUT_MAX, type CommandItem } from "@omp-app/protocol";
import { type CommandControl, type CommandOutcome, CommandRunner } from "../src/command-runner";
import { emptyViewModel } from "../src/reducer";
import { SessionStore } from "../src/session-store";

const SID = "s1";

function setup(run: CommandControl["runCommand"]) {
  const store = new SessionStore(() => 1000);
  store.create(emptyViewModel({ id: SID, cwd: "/work", model: null }));
  const saved: CommandItem[] = [];
  const prompts: string[] = [];
  const runner = new CommandRunner({
    store,
    control: {
      runCommand: run,
      saveCommand: (_id, command) => void saved.push(command),
    },
    prompt: (_id, text) => void prompts.push(text),
    refusal: (text) => (text.startsWith("/gated") ? "needs a confirmation" : null),
  });
  const item = (): CommandItem => {
    const found = store.snapshot(SID).snapshot.timeline.find((i) => i.kind === "command");
    if (found?.kind !== "command") throw new Error("no command item");
    return found;
  };
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 50 && item().state === "running"; i++) await Bun.sleep(1);
  };
  return { store, runner, saved, prompts, item, settled };
}

test("the item is on the timeline running before omp has printed anything, then collects its output", async () => {
  const release = Promise.withResolvers<void>();
  const printFirst = Promise.withResolvers<void>();
  const t = setup(async (_id, _text, output) => {
    await printFirst.promise;
    output("first");
    await release.promise;
    output("second");
    return { failed: false };
  });
  t.runner.start(SID, "/usage");
  expect(t.item()).toMatchObject({ text: "/usage", state: "running", output: "" });
  printFirst.resolve();
  await Bun.sleep(1);
  expect(t.item().output).toBe("first");
  release.resolve();
  await t.settled();
  expect(t.item()).toMatchObject({ state: "done", output: "first\nsecond" });
  expect(t.saved).toHaveLength(1);
  expect(t.saved[0]?.state).toBe("done");
});

test("omp reporting failure, or throwing, ends the item failed; the thrown sentence is kept as output", async () => {
  const failing = setup(async (_id, _text, output) => {
    output("Usage: /effort [level]");
    return { failed: true };
  });
  failing.runner.start(SID, "/effort nope");
  await failing.settled();
  expect(failing.item().state).toBe("failed");

  const throwing = setup(async () => {
    throw new Error("Cannot move while streaming.");
  });
  throwing.runner.start(SID, "/move /tmp");
  await throwing.settled();
  expect(throwing.item()).toMatchObject({
    state: "failed",
    output: "Cannot move while streaming.",
  });
  expect(throwing.saved).toHaveLength(1);
});

test("cancel aborts the signal; a builtin that returns normally anyway is done, one that fails or throws is stopped", async () => {
  let seen: AbortSignal | undefined;
  const t = setup(
    (_id, _text, _output, signal) =>
      new Promise<CommandOutcome>((resolve) => {
        seen = signal;
        signal.addEventListener("abort", () => resolve({ failed: false }));
      }),
  );
  t.runner.start(SID, "/compact");
  expect(t.runner.cancel(SID)).toBe(true);
  await t.settled();
  expect(seen?.aborted).toBe(true);
  expect(t.item().state).toBe("done");
  // Nothing left to stop.
  expect(t.runner.cancel(SID)).toBe(false);
});

test("a builtin that fails or throws after Stop ends stopped, not failed", async () => {
  for (const end of [
    (signal: AbortSignal) =>
      new Promise<CommandOutcome>((resolve) =>
        signal.addEventListener("abort", () => resolve({ failed: true })),
      ),
    (signal: AbortSignal) =>
      new Promise<CommandOutcome>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  ]) {
    const t = setup((_id, _text, _output, signal) => end(signal));
    t.runner.start(SID, "/compact");
    t.runner.cancel(SID);
    await t.settled();
    expect(t.item().state).toBe("stopped");
  }
});

test("a builtin that fails without a Stop ends failed", async () => {
  const t = setup(async () => ({ failed: true }));
  t.runner.start(SID, "/compact");
  await t.settled();
  expect(t.item().state).toBe("failed");
});

test("a prompt a builtin hands back is not sent when the gate refuses it; the item says why", async () => {
  const t = setup(async () => ({ prompt: "/gated thing" }));
  t.runner.start(SID, "/force read /gated thing");
  await t.settled();
  expect(t.prompts).toEqual([]);
  expect(t.item()).toMatchObject({ state: "failed", output: "needs a confirmation" });
  expect(t.saved[0]).toMatchObject({ state: "failed" });
});

test("a prompt a builtin hands back goes down the prompt path after the item is finished", async () => {
  const t = setup(async () => ({ prompt: "do the thing" }));
  t.runner.start(SID, "/force bash do the thing");
  await t.settled();
  expect(t.item().state).toBe("done");
  expect(t.prompts).toEqual(["do the thing"]);
});

test("output past the limit is cut and says so", async () => {
  const t = setup(async (_id, _text, output) => {
    output("x".repeat(COMMAND_OUTPUT_MAX + 500));
    output("more");
    return { failed: false };
  });
  t.runner.start(SID, "/dump");
  await t.settled();
  expect(t.item().output).toHaveLength(COMMAND_OUTPUT_MAX);
  expect(t.item().truncated).toBe(true);
});

test("a session that moved to a new id while the command ran gets the answer under its new id", async () => {
  const release = Promise.withResolvers<void>();
  const t = setup(async (_id, _text, output) => {
    await release.promise;
    output("done");
    return { failed: false };
  });
  t.runner.start(SID, "/usage");
  t.store.rekey(SID, "s2");
  release.resolve();
  await Bun.sleep(5);
  const found = t.store.snapshot("s2").snapshot.timeline[0];
  expect(found).toMatchObject({ kind: "command", state: "done", output: "done" });
  expect(t.saved[0]?.output).toBe("done");
});

test("a session closed while the command ran is not written to", async () => {
  const release = Promise.withResolvers<void>();
  const t = setup(async () => {
    await release.promise;
    return { failed: false };
  });
  t.runner.start(SID, "/usage");
  t.store.remove(SID);
  release.resolve();
  await Bun.sleep(5);
  expect(t.saved).toEqual([]);
});
