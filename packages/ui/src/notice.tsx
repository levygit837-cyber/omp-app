import type { ReactNode } from "react";
import { cx } from "./cx";
import { StateMark } from "./state-mark";

export interface NoticeProps {
  /** `warning`: works worse, still works (sulfur triangle). `error`: something stopped (red cross). */
  severity: "warning" | "error";
  /** What happened, one phrase. */
  title: ReactNode;
  /** Quieter continuation of the phrase. */
  detail?: ReactNode;
  /** Cause or output, indented under the phrase. */
  children?: ReactNode;
  className?: string;
  "data-testid"?: string;
}

/** An event line of the chat flow for something that is not the agent speaking. Never modal. */
export function Notice({ severity, title, detail, children, className, ...rest }: NoticeProps) {
  return (
    <div
      role={severity === "error" ? "alert" : "status"}
      className={cx("flex flex-col gap-(--space-event-inner)", className)}
      data-severity={severity}
      data-testid={rest["data-testid"]}
    >
      <p className="flex min-h-(--size-tool-row) items-center gap-(--space-icon-phrase) text-size-md">
        <StateMark state={severity === "error" ? "error" : "approval"} decorative />
        <span className="text-text-primary">{title}</span>
        {detail && <span className="text-text-secondary">{detail}</span>}
      </p>
      {children && (
        <div className="pl-(--space-output-indent) font-mono text-size-xs text-text-secondary">
          {children}
        </div>
      )}
    </div>
  );
}
