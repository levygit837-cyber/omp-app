import { useEffect, useState } from "react";

/**
 * The clock of a running line. It ticks only while `active`, so a finished line costs no timer
 * and a hundred of them in a long session cost nothing.
 */
export function useNow(active: boolean, stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(id);
  }, [active, stepMs]);
  return now;
}

/** `10000ms`, `10s`, `0.5s`: the minifier may rewrite a duration in the other unit. */
export function parseMs(raw: string): number {
  const match = /^(-?\d*\.?\d+)(ms|s)$/.exec(raw.trim());
  if (!match) return 0;
  const value = Number.parseFloat(match[1] as string);
  return match[2] === "s" ? value * 1000 : value;
}

const cache = new Map<string, number>();

/** A duration token from `tokens.css`, read once. The CSS stays the single source. */
export function tokenMs(name: string): number {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const value = parseMs(getComputedStyle(document.documentElement).getPropertyValue(name));
  cache.set(name, value);
  return value;
}
