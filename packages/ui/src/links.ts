export interface SafeLink {
  /** Normalised URL, safe to put in `href`. */
  href: string;
  scheme: "http" | "https";
}

// C0 controls, DEL and space. Browsers strip leading/trailing ones before parsing a URL and
// drop tab/CR/LF anywhere, so `  java\nscript:` is a real attack shape. We reject instead of strip.
function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
}

function trimEdges(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value.charCodeAt(start) <= 0x20 || value.charCodeAt(start) === 0x7f))
    start++;
  while (end > start && (value.charCodeAt(end - 1) <= 0x20 || value.charCodeAt(end - 1) === 0x7f))
    end--;
  return value.slice(start, end);
}

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) if (isControl(value.charCodeAt(i))) return true;
  return false;
}
const HTTP = /^(https?):\/\/[^\s/?#\\]/i;

/**
 * Allow-list for link destinations coming from model output: only http and https pass.
 * Relative URLs, protocol-relative `//host`, `http:\\host`, `javascript:`, `data:`, `file:` and
 * anything with embedded control characters return null (the caller renders plain text).
 */
export function safeLinkUrl(raw: string): SafeLink | null {
  const value = trimEdges(raw);
  if (value === "" || hasControl(value)) return null;
  const http = HTTP.exec(value);
  if (http) {
    try {
      const url = new URL(value);
      if (url.hostname === "") return null;
      return { href: url.href, scheme: url.protocol === "https:" ? "https" : "http" };
    } catch {
      return null;
    }
  }
  return null;
}
