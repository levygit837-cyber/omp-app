import { describe, expect, test } from "bun:test";
import {
  base64Bytes,
  EMPTY_QUEUE,
  isSessionFilesResult,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PROMPT,
  MAX_TOTAL_IMAGE_BYTES,
  refuseImages,
  sameQueue,
} from "../src/prompt";
import { GIF87_HEAD, GIF89_HEAD, JPEG_HEAD, PNG_HEAD, WEBP_HEAD } from "./images";

const png = (data = PNG_HEAD) => ({ mimeType: "image/png", data });
/** A valid PNG-headed payload of `bytes` decoded bytes (a multiple of 3). */
const pngOf = (bytes: number) => png(PNG_HEAD + "A".repeat(((bytes - 12) / 3) * 4));

describe("refuseImages", () => {
  test("accepts a few well-formed images of an allowed type", () => {
    expect(refuseImages([png(), { mimeType: "image/webp", data: WEBP_HEAD }])).toBeNull();
    expect(refuseImages([])).toBeNull();
  });

  test("refuses too many images", () => {
    expect(refuseImages(Array.from({ length: MAX_IMAGES_PER_PROMPT + 1 }, () => png()))).toBe(
      "count",
    );
  });

  test("refuses a type that is not an allowed image, including svg", () => {
    expect(refuseImages([{ mimeType: "image/svg+xml", data: "AAAA" }])).toBe("type");
    expect(refuseImages([{ mimeType: "application/pdf", data: "AAAA" }])).toBe("type");
  });

  test("accepts each type with its own signature", () => {
    for (const [mimeType, data] of [
      ["image/png", PNG_HEAD],
      ["image/jpeg", JPEG_HEAD],
      ["image/gif", GIF89_HEAD],
      ["image/gif", GIF87_HEAD],
      ["image/webp", WEBP_HEAD],
    ] as const) {
      expect(refuseImages([{ mimeType, data }])).toBeNull();
    }
  });

  test("refuses a signature that does not match the declared type", () => {
    expect(refuseImages([{ mimeType: "image/jpeg", data: PNG_HEAD }])).toBe("corrupt");
    expect(refuseImages([{ mimeType: "image/png", data: JPEG_HEAD }])).toBe("corrupt");
    expect(refuseImages([{ mimeType: "image/gif", data: WEBP_HEAD }])).toBe("corrupt");
    expect(refuseImages([{ mimeType: "image/webp", data: GIF89_HEAD }])).toBe("corrupt");
    expect(refuseImages([png("AAAA")])).toBe("corrupt");
  });

  test("refuses bad padding and a length that is not a multiple of 4", () => {
    expect(refuseImages([png(`${PNG_HEAD}A`)])).toBe("corrupt");
    expect(refuseImages([png(`${PNG_HEAD}AA`)])).toBe("corrupt");
    expect(refuseImages([png(`${PNG_HEAD}A===`)])).toBe("corrupt");
    expect(refuseImages([png(`${PNG_HEAD}=AAA`)])).toBe("corrupt");
    expect(refuseImages([png(`${PNG_HEAD}AA=A`)])).toBe("corrupt");
    expect(refuseImages([png(`${PNG_HEAD}AA==`)])).toBeNull();
    expect(refuseImages([png(`${PNG_HEAD}AAA=`)])).toBeNull();
  });

  test("checks an 11 MB string without catastrophic backtracking", () => {
    const big = PNG_HEAD + "A".repeat(11 * 1024 * 1024 - PNG_HEAD.length);
    const started = performance.now();
    expect(refuseImages([png(`${big.slice(0, -1)}!`)])).toBe("corrupt");
    expect(refuseImages([png(big)])).toBe("too_large");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("refuses images that are each under the per-image limit but too big together", () => {
    const each = MAX_IMAGE_BYTES - (MAX_IMAGE_BYTES % 3);
    expect(refuseImages([pngOf(each), pngOf(each)])).toBeNull();
    expect(refuseImages([pngOf(each), pngOf(each), pngOf(12)])).toBe("too_large");
    expect(2 * each + 12).toBeGreaterThan(MAX_TOTAL_IMAGE_BYTES);
  });

  test("refuses data that is not base64", () => {
    expect(refuseImages([png("not base64!")])).toBe("corrupt");
    expect(refuseImages([png("data:image/png;base64,AAAA")])).toBe("corrupt");
  });

  test("refuses an image past the size limit, by decoded size", () => {
    const limit = PNG_HEAD + "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4);
    expect(refuseImages([png(limit)])).toBe("too_large");
    expect(refuseImages([pngOf(MAX_IMAGE_BYTES - (MAX_IMAGE_BYTES % 3))])).toBeNull();
  });
});

describe("base64Bytes", () => {
  test("counts decoded bytes, taking padding off", () => {
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("AA==")).toBe(1);
    expect(base64Bytes("")).toBe(0);
  });
});

describe("sameQueue", () => {
  test("equal contents are the same, any difference is not", () => {
    expect(sameQueue(EMPTY_QUEUE, { steering: [], followUp: [], liveSteered: 0 })).toBe(true);
    const one = { steering: ["a"], followUp: ["b"], liveSteered: 0 };
    expect(sameQueue(one, { ...one })).toBe(true);
    expect(sameQueue(one, { ...one, liveSteered: 1 })).toBe(false);
    expect(sameQueue(one, { ...one, followUp: ["c"] })).toBe(false);
    expect(sameQueue(one, { ...one, steering: [] })).toBe(false);
  });
});

describe("isSessionFilesResult", () => {
  test("truncated is optional but must be a boolean when present", () => {
    expect(isSessionFilesResult({ files: ["a"] })).toBe(true);
    expect(isSessionFilesResult({ files: ["a"], truncated: true })).toBe(true);
    expect(isSessionFilesResult({ files: ["a"], truncated: "yes" })).toBe(false);
    expect(isSessionFilesResult({ files: [1] })).toBe(false);
  });
});
