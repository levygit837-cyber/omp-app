import { cx } from "./cx";
import type { DiffLine } from "./diff";

export interface DiffViewProps {
  lines: readonly DiffLine[];
  /** File path shown above the rows. */
  path?: string;
  className?: string;
}

/**
 * Numbered diff: line number, sign, text. Only the number and the sign carry color; the text stays
 * neutral. A table keeps the columns aligned while long text wraps under the text column.
 */
export function DiffView({ lines, path, className }: DiffViewProps) {
  return (
    <div className={cx("flex flex-col gap-(--space-4)", className)} data-diff-view>
      {path && <p className="font-mono text-size-xs text-text-dim">{path}</p>}
      <table className="w-full border-collapse font-mono text-size-sm leading-(--line-height-ui)">
        <tbody>
          {lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a diff is a static list
            <DiffRow key={i} line={line} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === "skip") {
    return (
      <tr>
        <td colSpan={3} className="py-(--space-2) text-text-dim">
          {line.text}
        </td>
      </tr>
    );
  }
  const number = line.kind === "remove" ? line.oldLine : line.newLine;
  const tint =
    line.kind === "add"
      ? "text-diff-add"
      : line.kind === "remove"
        ? "text-diff-remove"
        : "text-text-dim";
  return (
    <tr data-kind={line.kind}>
      <td className={cx("w-px select-none whitespace-nowrap pr-(--space-12) align-top", tint)}>
        {number}
      </td>
      <td
        aria-hidden="true"
        className={cx("w-px select-none whitespace-pre pr-(--space-8) align-top", tint)}
      >
        {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
      </td>
      <td className="whitespace-pre-wrap break-words text-text-primary">
        {line.kind !== "context" && (
          <span className="sr-only">{line.kind === "add" ? "added " : "removed "}</span>
        )}
        {line.text}
      </td>
    </tr>
  );
}
