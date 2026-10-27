import { cx } from "@omp-app/ui";
import type { Part, Phrase } from "../tool-phrases";

/** The words of a phrase: names, paths and commands in mono, the diff counts in their colors. */
export function Parts({ parts }: { parts: readonly Part[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a phrase is a static list
          key={i}
          className={cx(
            part.mono && "font-mono text-size-sm",
            part.tone === "add" && "font-mono text-diff-add",
            part.tone === "remove" && "font-mono text-diff-remove",
          )}
        >
          {part.text}
        </span>
      ))}
    </>
  );
}

/** Primary words, then the quiet facts after a middle dot. */
export function PhraseText({ phrase }: { phrase: Phrase }) {
  return (
    <>
      <span className="text-text-primary">
        <Parts parts={phrase.primary} />
      </span>
      {phrase.secondary.map((fact, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a phrase is a static list
        <span key={i} className="text-text-dim">
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          <Parts parts={fact} />
        </span>
      ))}
    </>
  );
}

/** Decorative tree glyphs (`├─`, `└─`): drawn, never read. */
export function Branch({ last }: { last: boolean }) {
  return (
    <span aria-hidden="true" className="shrink-0 select-none font-mono text-text-tree">
      {last ? "└─" : "├─"}
    </span>
  );
}
