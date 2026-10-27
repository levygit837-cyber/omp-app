import type { ComponentProps } from "react";
import { cx } from "./cx";

/**
 * Shape carries the meaning, color only reinforces it: arc = running, ring = idle,
 * triangle = awaiting approval, cross = failed. Success has no mark of its own.
 */
export type MarkState = "running" | "idle" | "approval" | "error";

const LABEL: Record<MarkState, string> = {
  running: "Running",
  idle: "Idle",
  approval: "Awaiting approval",
  error: "Failed",
};

const STROKE = "stroke-(length:--size-icon-stroke)";

export interface StateMarkProps extends Omit<ComponentProps<"svg">, "children"> {
  state: MarkState;
  /** Accessible name; defaults to the state's name. Pass `decorative` when text already says it. */
  label?: string;
  decorative?: boolean;
}

export function StateMark({ state, label, decorative, className, ...props }: StateMarkProps) {
  return (
    <svg
      viewBox="0 0 14 14"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : (label ?? LABEL[state])}
      aria-hidden={decorative ? true : undefined}
      data-mark={state}
      className={cx("size-(--size-mark) shrink-0", state === "running" && "ui-spinner", className)}
      {...props}
    >
      {state === "running" && (
        <>
          <circle cx="7" cy="7" r="5.5" className={cx(STROKE, "stroke-spinner-track")} />
          <path d="M7 1.5A5.5 5.5 0 0 1 12.5 7" className={cx(STROKE, "stroke-state-running")} />
        </>
      )}
      {state === "idle" && (
        <circle cx="7" cy="7" r="5.25" className={cx(STROKE, "stroke-state-done")} />
      )}
      {state === "approval" && (
        <path
          d="M7 2.25 12.5 11.75H1.5Z"
          className="fill-state-approval stroke-state-approval stroke-(length:--space-2)"
        />
      )}
      {state === "error" && (
        <path
          d="M3.5 3.5 10.5 10.5M10.5 3.5 3.5 10.5"
          className="stroke-state-error stroke-(length:--space-2)"
        />
      )}
    </svg>
  );
}
