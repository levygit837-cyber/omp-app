import { describe, expect, test } from "bun:test";
import {
  decodeFrame,
  encodeFrame,
  errorResponse,
  FrameDecoder,
  isHandshakeResult,
  isResponseEnvelope,
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
