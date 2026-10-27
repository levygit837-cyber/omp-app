import type { ComponentProps } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "approval" | "secondary" | "ghost";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent px-(--space-control-x) text-on-accent",
  /** The affirmative answer of a wait band: sulfur, because the band is sulfur. */
  approval: "bg-state-approval px-(--space-control-x) text-on-accent",
  secondary:
    "border border-border-control px-(--space-control-x) text-text-primary hover:bg-bg-hover",
  ghost: "px-(--space-4) text-text-secondary hover:text-text-primary",
};

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
}

/** Text button, 28 high. The primary action of a view is `primary`; at most one per view. A wait band has its own `approval`. */
export function Button({
  variant = "secondary",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex h-(--size-control) items-center justify-center gap-(--space-8) rounded-sm text-size-sm font-medium whitespace-nowrap",
        "disabled:opacity-(--opacity-disabled)",
        VARIANT[variant],
        className,
      )}
      {...props}
    />
  );
}

/** Square icon-only button. Needs an `aria-label`. */
export function IconButton({ className, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex size-(--size-control) items-center justify-center rounded-sm text-icon-neutral hover:bg-bg-hover",
        "disabled:opacity-(--opacity-disabled)",
        className,
      )}
      {...props}
    />
  );
}
