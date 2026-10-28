import { describe, expect, test } from "bun:test";
import {
  describeConfigProblem,
  describeEngineFailure,
  describeError,
  describeMcpFailure,
} from "../src/renderer/errors";

describe("describeEngineFailure", () => {
  test("an oversized frame is a sentence, not the protocol text", () => {
    const said = describeEngineFailure("frame line exceeds 33554432 characters");
    expect(said).not.toContain("33554432");
    expect(said).not.toContain("frame line");
  });

  test("the supervisor's own reasons pass through", () => {
    expect(describeEngineFailure("sidecar exited with code 1")).toBe("sidecar exited with code 1");
  });
});

describe("describeError", () => {
  test("a line the sidecar wanted confirmed becomes a sentence, not the raw refusal", () => {
    const text = describeError(
      new Error(
        "Error invoking remote method 'session:runCommand': Error: confirmation required: /session delete",
      ),
    );
    expect(text).toBe("/session delete needs a confirmation first. Nothing was run.");
  });

  test("a dead sidecar becomes a sentence, not the IPC text", () => {
    const raw = new Error(
      "Error invoking remote method 'session:cancel': Error: the sidecar is not ready",
    );
    const text = describeError(raw);
    expect(text).not.toContain("remote method");
    expect(text).not.toContain("session:cancel");
  });

  test("other errors lose the IPC prefix and keep their message", () => {
    const raw = new Error(
      "Error invoking remote method 'session:create': Error: no such directory",
    );
    expect(describeError(raw)).toBe("no such directory");
  });

  test("an extension command refused by the queue becomes a sentence without the command", () => {
    const said = describeError(
      new Error('Extension command "/deploy" cannot be queued. Use prompt() or execute it.'),
    );
    expect(said).not.toContain("deploy");
    expect(said).not.toContain("prompt()");
  });

  test("anything else is shown as text, and an empty message is never blank", () => {
    expect(describeError("plain")).toBe("plain");
    expect(describeError(new Error(""))).not.toBe("");
  });

  test("what the sidecar and omp say becomes a sentence, never the raw text", () => {
    const via = (text: string) =>
      describeError(new Error(`Error invoking remote method 'session:resume': Error: ${text}`));
    expect(via("session not found: 7f3c-uuid")).not.toContain("7f3c");
    expect(via("folder no longer exists: /gone")).toContain("/gone");
    expect(via("Could not restore model openai/gpt-x")).toContain("openai/gpt-x");
    expect(via("unknown session: abc")).not.toContain("abc");
    expect(via("ACP session fork is unavailable while a prompt is in progress: abc")).not.toContain(
      "abc",
    );
  });
});

describe("describeConfigProblem", () => {
  test("omp's validation text becomes sentences, one per objection", () => {
    expect(describeConfigProblem('Server "x": stdio server requires "command" field')).toBe(
      "This stdio server needs a command.",
    );
    expect(describeConfigProblem('Server "x": sse server requires "url" field')).toBe(
      "This sse server needs a URL.",
    );
    expect(describeConfigProblem('Server "x": unknown server type "ws"')).toContain("“ws”");
    expect(describeConfigProblem("Server name is too long (max 100 characters)")).toBe(
      "That name is longer than 100 characters.",
    );
    const two = describeConfigProblem(
      'Server "x": both "command" and "url" are set - server should be either stdio (command) OR http/sse (url), not both Server "x": stdio server requires "command" field',
    );
    expect(two).not.toContain("Server");
    expect(two).toContain("Keep one.");
    expect(two).toContain("needs a command");
  });

  test("the sidecar's own sentences pass through", () => {
    expect(
      describeConfigProblem("Another process is writing this file. Try again in a moment."),
    ).toBe("Another process is writing this file. Try again in a moment.");
  });
});

describe("describeMcpFailure", () => {
  test("a connection failure is a sentence and never the process text", () => {
    expect(describeMcpFailure("spawn npx ENOENT")).toContain("wasn’t found");
    expect(describeMcpFailure("connect ECONNREFUSED 127.0.0.1:9")).toContain("reach the server");
    expect(describeMcpFailure("HTTP 401 Unauthorized")).toContain("credentials");
    expect(describeMcpFailure("Request timed out")).toContain("in time");
    const unknown = describeMcpFailure("boom at /Users/someone/x.js:3");
    expect(unknown).not.toContain("/Users");
  });
});
