import { type Attachment, base64Bytes } from "@omp-app/protocol";
import { isRecord } from "./tool-output";

/**
 * The images a user message carried, as the timeline shows them (type and size, never the
 * bytes). omp may have downsized them before they reached the message, so this is what was sent.
 * Empty for a plain text message.
 */
export function attachmentsOf(content: unknown): Attachment[] {
  if (!Array.isArray(content)) return [];
  const images: Attachment[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "image" || typeof part.data !== "string") continue;
    images.push({
      kind: "image",
      mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/*",
      bytes: base64Bytes(part.data),
    });
  }
  return images;
}

/** The level the person chose, as the view model keeps it. Null when the model has no thinking control. */
export function thinkingOf(
  level: string | undefined,
  configured: string | undefined,
): string | null {
  const chosen = configured ?? level;
  if (chosen === undefined) return null;
  return chosen === "inherit" ? "off" : chosen;
}

/**
 * omp's `fileMention` message: the files it read for the `@` references of a prompt
 * (`generateFileMentionMessages`, `file-mentions.ts` [V]). Its role is not in the event union's
 * type, so it is recognised by shape.
 */
export function isFileMention(
  message: unknown,
): message is { role: "fileMention"; files?: unknown } {
  return isRecord(message) && message.role === "fileMention";
}

/** The paths omp read, without the ones it skipped (too large, binary). */
export function mentionedFiles(message: { files?: unknown }): string[] {
  if (!Array.isArray(message.files)) return [];
  const paths: string[] = [];
  for (const file of message.files) {
    if (!isRecord(file) || typeof file.path !== "string" || file.skippedReason !== undefined)
      continue;
    paths.push(file.path);
  }
  return paths;
}
