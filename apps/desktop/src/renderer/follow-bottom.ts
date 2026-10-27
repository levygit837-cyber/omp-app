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
