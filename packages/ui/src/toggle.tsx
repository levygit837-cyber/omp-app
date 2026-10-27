import type { ComponentProps } from "react";
import { cx } from "./cx";

export interface ToggleProps extends Omit<ComponentProps<"button">, "onClick" | "role"> {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}

/**
 * A switch. On is neutral (the track takes the icon grey), never green or accent: color marks
 * are reserved for running, approval and error. Off is outlined in `border-field` (3.2:1 on
 * bg-base) so the track is visible without color. Needs an accessible name (`aria-labelledby`).
 */
export function Toggle({
  checked,
  onCheckedChange,
  className,
  type = "button",
  ...props
}: ToggleProps) {
  return (
    <button
      type={type}
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        "inline-flex h-(--size-toggle-height) w-(--size-toggle-width) shrink-0 items-center rounded-full border p-(--space-2)",
        checked ? "border-transparent bg-icon-neutral" : "border-border-field bg-bg-user",
        "disabled:opacity-(--opacity-disabled)",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cx(
          "size-(--size-toggle-knob) rounded-full transition-transform duration-(--motion-duration-fast)",
          checked ? "translate-x-(--size-toggle-travel) bg-bg-base" : "bg-text-dim",
        )}
      />
    </button>
  );
}
