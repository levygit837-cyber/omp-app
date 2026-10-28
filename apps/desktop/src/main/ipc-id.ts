/** Longest id the renderer may name in a cancel request. Ids are uuids, `view:` ids or omp's short agent ids. */
export const MAX_ID_LENGTH = 256;

/**
 * An id that arrives over IPC from the renderer: a non-empty string of bounded length. The sidecar
 * looks it up by equality and never builds a path from it, so length is the one remaining bound.
 */
export function ipcId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a string`);
  if (value.length > MAX_ID_LENGTH) throw new Error(`${name} is too long`);
  return value;
}
