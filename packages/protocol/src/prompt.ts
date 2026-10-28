/**
 * Prompt controls: what a prompt can carry (images), the queue of input that waits for the
 * running turn, and the model choices of a session. File references travel as `@path` text,
 * which omp expands itself; the app only lists candidates (`session.files`).
 */
import { isRecord } from "./guards";

/**
 * Images a prompt may carry. omp downsizes images itself before sending them (`resizeImage`,
 * 1568 px and 500 KB by default, `utils/image-resize.ts` [S]), so the app only bounds what it
 * moves between processes and refuses what no provider takes.
 */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
/** Decoded size of one image. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Decoded bytes allowed across all the images of one prompt. */
export const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGES_PER_PROMPT = 4;
/** Most files one `session.files` call returns. */
export const MAX_FILE_MATCHES = 50;
/** Longest `session.files` query. */
export const MAX_FILE_QUERY_CHARS = 200;

/** Where a prompt sent while the agent works goes. `steer` joins the running turn. */
export type Delivery = "steer" | "followUp";
export type QueueName = "steering" | "followUp";

/** An image on its way to the agent: base64 bytes with their type. */
export interface PromptImage {
  readonly mimeType: string;
  readonly data: string;
}

/** What the timeline keeps about an image of a sent message. The bytes are not kept. */
export interface Attachment {
  readonly kind: "image";
  readonly mimeType: string;
  readonly bytes: number;
}

/**
 * Input the agent has accepted but not yet recorded in the conversation, as omp's `queue_update`
 * reports it (`agent-session-events.ts` [V]). The first `liveSteered` entries of `steering`
 * were already sent into the response being streamed and can no longer be removed.
 */
export interface QueueState {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
  readonly liveSteered: number;
}

export const EMPTY_QUEUE: QueueState = { steering: [], followUp: [], liveSteered: 0 };

/** One model the session can switch to: it has credentials. */
export interface ModelOption {
  /** `provider/id`, the form the view model uses for the active model. */
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  /** Thinking levels the model accepts, lowest first. Empty when it has no thinking control. */
  readonly efforts: readonly string[];
}

export interface SessionModelsResult {
  readonly models: readonly ModelOption[];
}

export interface SessionFilesResult {
  /** Paths relative to the session folder, best match first. Folders end in `/`. */
  readonly files: readonly string[];
  /** True when the listing stopped early, so matches may be missing. */
  readonly truncated?: boolean;
}

export interface RemoveQueuedResult {
  /** False when the message had already been delivered (or was never there). */
  readonly removed: boolean;
}

/**
 * Prefix of the error for an image the app refuses. What follows the colon is one of
 * {@link ImageRefusal}. Shared because Electron's IPC keeps only the message text.
 */
export const IMAGE_REFUSED_MESSAGE = "image refused";
export type ImageRefusal = "too_large" | "type" | "count" | "corrupt";

/** Error for switching model or thinking while a turn runs: the choice is for the next turn. */
export const SESSION_BUSY_MESSAGE = "session is busy";

export function isImageMimeType(v: unknown): v is ImageMimeType {
  return typeof v === "string" && (IMAGE_MIME_TYPES as readonly string[]).includes(v);
}

export function isPromptImage(v: unknown): v is PromptImage {
  return isRecord(v) && typeof v.mimeType === "string" && typeof v.data === "string";
}

export function isAttachment(v: unknown): v is Attachment {
  return (
    isRecord(v) &&
    v.kind === "image" &&
    typeof v.mimeType === "string" &&
    typeof v.bytes === "number"
  );
}

const isStringList = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

export function isQueueState(v: unknown): v is QueueState {
  return (
    isRecord(v) &&
    isStringList(v.steering) &&
    isStringList(v.followUp) &&
    typeof v.liveSteered === "number"
  );
}

export function isModelOption(v: unknown): v is ModelOption {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.provider === "string" &&
    typeof v.name === "string" &&
    isStringList(v.efforts)
  );
}

export function isSessionModelsResult(v: unknown): v is SessionModelsResult {
  return isRecord(v) && Array.isArray(v.models) && v.models.every(isModelOption);
}

export function isSessionFilesResult(v: unknown): v is SessionFilesResult {
  return (
    isRecord(v) &&
    isStringList(v.files) &&
    (v.truncated === undefined || typeof v.truncated === "boolean")
  );
}

export function isRemoveQueuedResult(v: unknown): v is RemoveQueuedResult {
  return isRecord(v) && typeof v.removed === "boolean";
}

/** Decoded size of a base64 string, without decoding it. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * Alphabet check without a counted group: `(?:[A-Za-z0-9+/]{4})*` makes the regex engine fail
 * on strings past ~8.3M characters, which would refuse valid images near the size limit.
 */
const BASE64_BODY = /^[A-Za-z0-9+/]*$/;

/** Strict base64: length a multiple of 4, at most two trailing `=`, nothing else off-alphabet. */
function isStrictBase64(data: string): boolean {
  if (data.length % 4 !== 0) return false;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return BASE64_BODY.test(padding === 0 ? data : data.slice(0, -padding));
}

/** Characters of base64 that cover the longest signature checked (12 bytes). */
const SIGNATURE_CHARS = 16;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(head: readonly number[], signature: readonly number[], at = 0): boolean {
  return signature.every((byte, i) => head[at + i] === byte);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes of a base64 string whose length is a multiple of 4 (padding included). */
function decodeBase64Head(data: string): number[] {
  const bytes: number[] = [];
  for (let at = 0; at < data.length; at += 4) {
    let bits = 0;
    let pad = 0;
    for (let i = 0; i < 4; i++) {
      const char = data[at + i];
      if (char === "=") pad++;
      bits = (bits << 6) | (char === "=" ? 0 : BASE64_ALPHABET.indexOf(char ?? "A"));
    }
    bytes.push((bits >> 16) & 0xff);
    if (pad < 2) bytes.push((bits >> 8) & 0xff);
    if (pad < 1) bytes.push(bits & 0xff);
  }
  return bytes;
}

/** Whether the first bytes of the image are the signature of the declared type. */
function matchesSignature(mimeType: ImageMimeType, data: string): boolean {
  const head = decodeBase64Head(data.slice(0, SIGNATURE_CHARS));
  switch (mimeType) {
    case "image/png":
      return startsWith(head, PNG_SIGNATURE);
    case "image/jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return (
        startsWith(head, [0x47, 0x49, 0x46, 0x38]) &&
        (head[4] === 0x37 || head[4] === 0x39) &&
        head[5] === 0x61
      );
    case "image/webp":
      return (
        startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)
      );
  }
}

/**
 * The checks every side applies before images cross a process: count, type, strict base64,
 * magic bytes matching the declared type, and size (per image and in total). Returns the
 * refusal, or null when the images are acceptable.
 */
export function refuseImages(images: readonly PromptImage[]): ImageRefusal | null {
  if (images.length > MAX_IMAGES_PER_PROMPT) return "count";
  let total = 0;
  for (const image of images) {
    if (!isImageMimeType(image.mimeType)) return "type";
    if (!isStrictBase64(image.data) || !matchesSignature(image.mimeType, image.data)) {
      return "corrupt";
    }
    const bytes = base64Bytes(image.data);
    if (bytes > MAX_IMAGE_BYTES) return "too_large";
    total += bytes;
    if (total > MAX_TOTAL_IMAGE_BYTES) return "too_large";
  }
  return null;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((text, i) => text === b[i]);

/** Whether two queue snapshots say the same thing, so a no-op update keeps the identity. */
export function sameQueue(a: QueueState, b: QueueState): boolean {
  return (
    a.liveSteered === b.liveSteered &&
    sameList(a.steering, b.steering) &&
    sameList(a.followUp, b.followUp)
  );
}
