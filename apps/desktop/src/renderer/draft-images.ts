import { base64Bytes } from "@omp-app/protocol";
import { formatBytes, imageProblem } from "./prompt-input";

/** An image the person attached and has not sent yet. */
export interface DraftImage {
  readonly id: number;
  readonly name: string;
  readonly mimeType: string;
  /** Base64, without the `data:` prefix. */
  readonly data: string;
  readonly bytes: number;
}

export const imageChipText = (image: DraftImage): string =>
  `${image.name} · ${formatBytes(image.bytes)}`;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

let nextId = 1;

/**
 * Reads the files that can be attached (type, size, count and total bytes are checked first) and says why the
 * first one that cannot was refused. Nothing leaves the window here: the bytes stay in memory
 * until the prompt is sent.
 */
export async function readImages(
  files: readonly File[],
  alreadyAttached: number,
  alreadyBytes = 0,
): Promise<{ added: DraftImage[]; problem: string | null }> {
  const added: DraftImage[] = [];
  let problem: string | null = null;
  let addedBytes = 0;
  for (const file of files) {
    const refusal = imageProblem(file, alreadyAttached + added.length, alreadyBytes + addedBytes);
    if (refusal) {
      problem ??= refusal;
      continue;
    }
    try {
      const data = await readBase64(file);
      const bytes = base64Bytes(data);
      added.push({
        id: nextId++,
        name: file.name || "pasted image",
        mimeType: file.type,
        data,
        bytes,
      });
      addedBytes += bytes;
    } catch {
      problem ??= "That image couldn’t be read. Try another one.";
    }
  }
  return { added, problem };
}
