import type { ComponentProps, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { StateMark } from "./state-mark";

export interface WaitBandProps extends Omit<ComponentProps<"section">, "title"> {
  /** What is waited for, in capitals: `WAITING FOR YOU`, `QUESTION · PICK ONE`. */
  label: ReactNode;
  /** Quiet text after the label, such as the time waited. */
  timer?: ReactNode;
  ref?: Ref<HTMLElement>;
}

/**
 * The chat's one boxed element: the agent is stopped until a person answers. Two sulfur rules
 * above and below, no side rail, no card. The answer controls go in `children`; the band owns
 * only its frame and header. It is a focus target (`tabIndex=-1`) so a click on the docked tab
 * can lead here; it draws no ring of its own, because a ring would make a second box of it.
 * The controls inside keep their rings.
 * Children never shrink: past the height cap the band scrolls, so a long multi-line message (a plan
 * to approve) is not squeezed under the choices.
 */
export function WaitBand({ label, timer, className, children, ...props }: WaitBandProps) {
  return (
    <section
      tabIndex={-1}
      className={cx(
        "flex max-h-(--layout-band-max) flex-col gap-(--space-14) overflow-y-auto *:shrink-0 border-y border-state-approval-rule outline-none pt-(--space-14) pb-(--space-18)",
        className,
      )}
      {...props}
    >
      <header className="flex items-center gap-(--space-8) font-mono text-size-2xs">
        <StateMark state="approval" decorative />
        <span className="tracking-caps text-state-approval">{label}</span>
        {timer && <span className="text-text-dim">{timer}</span>}
      </header>
      {children}
    </section>
  );
}
