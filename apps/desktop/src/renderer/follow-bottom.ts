/** Scroll geometry of a container, as the DOM reports it. */
export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

/**
 * How far from the end still counts as "at the end", in CSS pixels. Sub-pixel rounding and a
 * message that grows by a line between two frames must not be read as the user scrolling away.
 */
export const FOLLOW_SLACK = 24;

export function isNearBottom(metrics: ScrollMetrics, slack: number = FOLLOW_SLACK): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack;
}

/**
 * What a `scroll` event means for following. Only the user can leave the end: the virtualizer
 * also writes `scrollTop` (to correct for rows measured above the viewport) and the content grows
 * under a pinned view, and both fire `scroll` with the end further away than the slack. Reading
 * that distance as "the user scrolled up" is what stopped following on open. Reaching the end
 * resumes following, except while a press is held: dragging the scrollbar or a text selection
 * moves the view under the user's hand, and a pinned view would fight it on every frame.
 */
export function followAfterScroll(
  following: boolean,
  userScrolling: boolean,
  metrics: ScrollMetrics,
  pressHeld: boolean = false,
): boolean {
  if (pressHeld) return false;
  if (isNearBottom(metrics)) return true;
  return userScrolling ? false : following;
}

/**
 * The press ended: follow again if, and only if, the user left the view at the end. `left` is the
 * geometry at the last scroll the press caused (at the press itself if the view never moved), not
 * the geometry at release: a reply that kept growing under a held scrollbar would otherwise push
 * the end out of reach while the user was already there.
 */
export function followAfterRelease(left: ScrollMetrics): boolean {
  return isNearBottom(left);
}

/** Whether a pointer press is the user taking hold of the scroller (scrollbar, selection, touch). */
export function isScrollPress(button: number): boolean {
  return button === 0;
}

/** Keys that move the view towards the start of the conversation. */
export function movesTowardsStart(key: string, shift: boolean): boolean {
  return key === "ArrowUp" || key === "PageUp" || key === "Home" || (key === " " && shift);
}

export interface KeyModifiers {
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
}

/**
 * Keys that jump to an end of the conversation in one write: Home and End, and on macOS
 * Cmd+Up and Cmd+Down. The browser's own jump is animated, and the virtualizer's corrections for
 * rows measured on the way cancel it half-way.
 */
export function jumpTarget(key: string, mods: KeyModifiers): "start" | "end" | null {
  if (mods.ctrl || mods.alt) return null;
  if (!mods.meta) return key === "Home" ? "start" : key === "End" ? "end" : null;
  return key === "ArrowUp" ? "start" : key === "ArrowDown" ? "end" : null;
}
