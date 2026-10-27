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
 * always resumes following.
 */
export function followAfterScroll(
  following: boolean,
  userScrolling: boolean,
  metrics: ScrollMetrics,
): boolean {
  if (isNearBottom(metrics)) return true;
  return userScrolling ? false : following;
}

/** Keys that move the view towards the start of the conversation. */
export function movesTowardsStart(key: string, shift: boolean): boolean {
  return key === "ArrowUp" || key === "PageUp" || key === "Home" || (key === " " && shift);
}
