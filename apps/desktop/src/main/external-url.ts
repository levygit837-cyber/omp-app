/**
 * The only URLs the app hands to the system browser. The renderer shows text written by a model,
 * so a link in it is untrusted input: anything but a plain web address is refused.
 */
export function externalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  // Control characters (including tab and newline, which URL parsers strip) hide a scheme.
  if (/[\p{Cc}\s]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href;
}
