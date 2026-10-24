/** Narrows to an object; its fields stay `unknown`. The one guard this package uses. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
