import type { CompactionItem } from "@omp-app/protocol";

/** Smallest `tokensBefore` worth printing: a conversation that needed compacting is never smaller. */
const MIN_PRINTED_TOKENS = 1000;

/**
 * What the boundary says about its size, or undefined when it should say nothing. omp's
 * `tokensBefore` comes from the provider's usage; a provider that reports few or no input tokens
 * (kiro in the recorded fixture: 41) would print "0k". The compaction itself is still shown,
 * only without the number.
 */
export function compactionSize(item: CompactionItem): string | undefined {
  const tokens = item.tokensBefore;
  if (tokens === undefined || tokens < MIN_PRINTED_TOKENS) return undefined;
  return `${Math.round(tokens / 1000)}k tokens summarized`;
}
