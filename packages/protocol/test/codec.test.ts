import { describe, expect, test } from "bun:test";
import {
  decodeFrame,
  encodeFrame,
  errorResponse,
  FrameDecoder,
  FrameTooLongError,
  isHandshakeResult,
  isResponseEnvelope,
  MAX_FRAME_CHARS,
  okResponse,
  PROTOCOL_VERSION,
  RequestCorrelator,
} from "../src/index";

const handshake = {
  protocolVersion: PROTOCOL_VERSION,
  sidecarVersion: "1.2.3",
  ompVersion: "4.5.6",
  capabilities: ["handshake"],
  mode: "normal" as const,
};

/** Encodes then decodes, i.e. what actually survives the wire. */
function overTheWire(envelope: Parameters<typeof encodeFrame>[0]) {
  const [line] = new FrameDecoder().push(encodeFrame(envelope));
  return decodeFrame(line as string);
}

describe("response envelopes over the wire", () => {
  test("a void result survives as null and is still a valid ok response", () => {
    // JSON.stringify would drop `result: undefined`, and isResponseEnvelope rejects a
    // response with no `result` key.
    const decoded = overTheWire(okResponse("7", undefined));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(isResponseEnvelope(decoded.envelope)).toBe(true);
    expect(decoded.envelope).toEqual({ kind: "response", id: "7", ok: true, result: null });
  });

  test("a value result round-trips unchanged", () => {
    const decoded = overTheWire(okResponse("1", handshake));

    expect(decoded.ok && decoded.envelope).toEqual({
      kind: "response",
      id: "1",
      ok: true,
      result: handshake,
    });
  });

  test("falsy but defined results are not turned into null", () => {
    for (const value of [0, false, ""]) {
      const decoded = overTheWire(okResponse("1", value));
      expect(decoded.ok && decoded.envelope).toMatchObject({ result: value });
    }
  });

  test("a typed error round-trips", () => {
    const decoded = overTheWire(errorResponse("2", { code: "disabled", message: "off" }));

    expect(decoded.ok && decoded.envelope).toEqual({
      kind: "response",
      id: "2",
      ok: false,
      error: { code: "disabled", message: "off" },
    });
  });

  test("an ok response with no result key is rejected as malformed", () => {
    expect(isResponseEnvelope({ kind: "response", id: "1", ok: true })).toBe(false);
  });
});

describe("handshake result", () => {
  test("requires a numeric protocolVersion", () => {
    expect(isHandshakeResult(handshake)).toBe(true);
    const { protocolVersion: _, ...withoutVersion } = handshake;
    expect(isHandshakeResult(withoutVersion)).toBe(false);
    expect(isHandshakeResult({ ...handshake, protocolVersion: "1" })).toBe(false);
  });

  test("read_only requires both schema versions", () => {
    const schema = { onDisk: 7, expected: 6 };
    expect(isHandshakeResult({ ...handshake, mode: "read_only", schema })).toBe(true);
    expect(isHandshakeResult({ ...handshake, mode: "read_only" })).toBe(false);
    expect(isHandshakeResult({ ...handshake, mode: "other" })).toBe(false);
  });
});

describe("RequestCorrelator", () => {
  test("settles a request with the matching typed result", async () => {
    const correlator = new RequestCorrelator();
    const { frame, response } = correlator.create("handshake");
    const sent = decodeFrame(frame.trim());
    expect(sent.ok && sent.envelope).toMatchObject({ kind: "request", method: "handshake" });

    correlator.receive(
      okResponse((sent.ok && (sent.envelope as { id: string }).id) || "", handshake),
    );

    expect(await response).toEqual(handshake);
  });

  test("rejects a result that fails the method's guard", async () => {
    const correlator = new RequestCorrelator();
    const { response } = correlator.create("handshake");

    correlator.receive(okResponse("1", { ompVersion: "x" }));

    await expect(response).rejects.toThrow(/malformed handshake result/);
  });
});

describe("FrameDecoder", () => {
  test("joins a line split across chunks and keeps the trailing partial", () => {
    const decoder = new FrameDecoder();

    expect(decoder.push('{"a"')).toEqual([]);
    expect(decoder.push(":1}\n{")).toEqual(['{"a":1}']);
    expect(decoder.push('"b":2}\n')).toEqual(['{"b":2}']);
  });

  test("returns several lines from one chunk, trimming trailing whitespace and dropping empty lines", () => {
    const decoder = new FrameDecoder();

    expect(decoder.push("one \r\n\n  \ntwo\nthr")).toEqual(["one", "two"]);
    expect(decoder.push("ee\n")).toEqual(["three"]);
  });

  test("decodes a frame of the cap size in 64 KB chunks in linear time, not quadratic", () => {
    const line = "x".repeat(MAX_FRAME_CHARS);
    const chunk = 64 * 1024;
    const chunks: string[] = [];
    for (let at = 0; at < line.length; at += chunk) chunks.push(line.slice(at, at + chunk));

    // The decoder this one replaced: re-split the whole buffer on every chunk.
    const quadratic = () => {
      let buffer = "";
      let out: string[] = [];
      for (const piece of [...chunks, "\n"]) {
        buffer += piece;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        out = lines;
      }
      return out;
    };
    const linear = () => {
      const decoder = new FrameDecoder();
      let out: string[] = [];
      for (const piece of [...chunks, "\n"]) out = [...out, ...decoder.push(piece)];
      return out;
    };
    const timed = (run: () => string[]) => {
      const started = performance.now();
      const out = run();
      return { ms: performance.now() - started, out };
    };

    const reference = timed(quadratic);
    const actual = timed(linear);

    // Measured against a quadratic reference run in the same test, so a slow or loaded machine
    // slows both: on a quiet one the decoder takes ~6 ms and the reference ~770 ms.
    expect(actual.ms * 5).toBeLessThan(reference.ms);
    expect(actual.out.length).toBe(1);
    expect(actual.out[0] === line).toBe(true);
  });

  test("lines a chunk completed before an oversized one come with the error, not lost", () => {
    const decoder = new FrameDecoder();
    const huge = "z".repeat(MAX_FRAME_CHARS + 1);

    let caught: unknown;
    try {
      decoder.push(`first\nsecond\n${huge}`);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FrameTooLongError);
    expect((caught as FrameTooLongError).complete).toEqual(["first", "second"]);
    expect(decoder.push("after\n")).toEqual(["after"]);
  });

  test("a partial line finished by a chunk that then overflows is one of the complete lines", () => {
    const decoder = new FrameDecoder();
    decoder.push("par");

    const caught = (() => {
      try {
        decoder.push(`tial\n${"y".repeat(MAX_FRAME_CHARS + 1)}`);
      } catch (error) {
        return error;
      }
    })();

    expect(caught).toBeInstanceOf(FrameTooLongError);
    expect(caught instanceof FrameTooLongError && caught.complete).toEqual(["partial"]);
  });

  test("throws FrameTooLongError past the cap, resets, and keeps working", () => {
    const decoder = new FrameDecoder();
    const chunk = "y".repeat(1024 * 1024);

    expect(() => {
      for (let sent = 0; sent <= MAX_FRAME_CHARS; sent += chunk.length) decoder.push(chunk);
    }).toThrow(FrameTooLongError);

    expect(decoder.push("ok\nnext\n")).toEqual(["ok", "next"]);
  });

  test("a long line that ends within the cap is accepted", () => {
    const decoder = new FrameDecoder();
    const body = "z".repeat(MAX_FRAME_CHARS);

    expect(decoder.push(`${body}\n`)).toEqual([body]);
  });
});
