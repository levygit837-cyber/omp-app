import type { ReactNode } from "react";
import { cx } from "./cx";

export interface ChipProps {
  /** Leading glyph, decorative. */
  icon?: ReactNode;
  /** The chip's text. Long text is cut with an ellipsis; the full text is the `title`. */
  children: string;
  /** Accessible name of the remove button. Without `onRemove` the chip has no button. */
  removeLabel?: string;
  onRemove?: () => void;
  /** A muted chip reads as already settled (a delivered or unreachable entry). */
  muted?: boolean;
  className?: string;
}

/**
 * A small labelled token, optionally removable: an attached file or image above the input bar, a
 * queued message. The remove button is a real button, so it takes Tab and Enter/Space, and
 * Backspace/Delete on it removes too. No color carries meaning; the text and the button do.
 */
export function Chip({ icon, children, removeLabel, onRemove, muted, className }: ChipProps) {
  return (
    <span
      title={children}
      className={cx(
        "inline-flex h-(--size-control) max-w-(--layout-chip-max) items-center gap-(--space-6) rounded-sm border border-border-default pr-(--space-4) pl-(--space-8) text-size-xs",
        muted ? "text-text-dim" : "text-text-secondary",
        className,
      )}
    >
      {icon && (
        <span aria-hidden="true" className="flex shrink-0 items-center">
          {icon}
        </span>
      )}
      <span className="min-w-0 truncate font-mono">{children}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          onKeyDown={(event) => {
            if (event.key === "Backspace" || event.key === "Delete") {
              event.preventDefault();
              onRemove();
            }
          }}
          className="inline-flex size-(--size-chip-remove) shrink-0 items-center justify-center rounded-sm text-text-dim hover:bg-bg-hover hover:text-text-primary"
        >
          ×
        </button>
      )}
    </span>
  );
}
