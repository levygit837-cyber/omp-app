/**
 * Whether a scroll should close a card that hangs from `opener`. Only a scroll that can move the
 * opener matters: a timeline streaming elsewhere scrolls all the time without touching it. With
 * no opener there is nothing to compare against, so any scroll closes.
 * `scrolled` is the scroll event's target, null when it is not a node (the document itself is one).
 */
export function scrollClosesCard<N>(
  scrolled: { contains(node: N): boolean } | null,
  opener: N | null | undefined,
): boolean {
  if (opener === null || opener === undefined) return true;
  return scrolled?.contains(opener) ?? false;
}
