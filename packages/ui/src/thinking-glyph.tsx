import type { ComponentProps } from "react";
import { cx } from "./cx";

export interface ThinkingGlyphProps extends Omit<ComponentProps<"svg">, "children"> {
  /** The agent is thinking now: the lit dot turns, six frames per cycle (Pen frame `ydUtM`). */
  live?: boolean;
}

/**
 * Three dots. Alive, the lit one turns clockwise (top, right, left) and leaves a short trail,
 * one frame at a time instead of a continuous fade; finished, all three sit in the quiet tone, so
 * the swap to "done" does not jump.
 */
export function ThinkingGlyph({ live = false, className, ...props }: ThinkingGlyphProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      className={cx("size-(--size-icon-tool) shrink-0", className)}
      {...props}
    >
      <circle
        cx="10"
        cy="6.5"
        r="1.6"
        className={live ? "ui-think-dot ui-think-top" : "fill-state-done"}
      />
      <circle
        cx="13.25"
        cy="12.5"
        r="1.6"
        className={live ? "ui-think-dot ui-think-right" : "fill-state-done"}
      />
      <circle
        cx="6.75"
        cy="12.5"
        r="1.6"
        className={live ? "ui-think-dot ui-think-left" : "fill-state-done"}
      />
    </svg>
  );
}
