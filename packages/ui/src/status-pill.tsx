import type { ComponentProps } from "react";
import { cx } from "./cx";

/** A blocking state named in a word (READ-ONLY). Sulfur outline; the word, not the color, says it. */
export function StatusPill({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-sm border border-state-approval px-(--space-6) py-(--space-2) font-mono text-size-2xs tracking-caps text-state-approval uppercase",
        className,
      )}
      {...props}
    />
  );
}
