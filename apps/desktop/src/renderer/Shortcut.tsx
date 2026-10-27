import { cx } from "@omp-app/ui";

/** A key hint such as ⌘R. Not used for letters that read as digits at this size (⌘O looks like ⌘0). */
export function Shortcut({ children, className }: { children: string; className?: string }) {
  const [symbol, ...rest] = Array.from(children);
  return (
    <kbd
      className={cx(
        "inline-flex items-baseline gap-(--space-2) font-text text-size-2xs",
        className,
      )}
    >
      <span>{symbol}</span>
      <span>{rest.join("")}</span>
    </kbd>
  );
}
