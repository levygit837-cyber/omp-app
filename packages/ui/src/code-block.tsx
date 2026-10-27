import { useEffect, useMemo, useState } from "react";
import { cx } from "./cx";
import { canHighlight, ensureGrammar, grammarFor, highlightCached } from "./highlight-loader";
import type { HighlightSpan } from "./highlight-spans";
import { parseFenceInfo } from "./languages";

export interface CodeBlockProps {
  code: string;
  /** Language name, alias or a whole fence info string (`ts`, `language-bash`, `bash title=x`). Unknown: plain. */
  language?: string | null;
  filename?: string | null;
  /** Number of the first line. Default 1. */
  startLine?: number;
  /** Set false to skip syntax highlighting. Default true. */
  highlight?: boolean;
  /**
   * The fence is still open (the model is writing it). Highlighting waits until it closes: colors
   * that appear and vanish on every delta would flicker, and the plain text already reads fine.
   */
  streaming?: boolean;
  className?: string;
}

function renderSpans(spans: readonly HighlightSpan[]) {
  return spans.map((span, i) =>
    span.kind ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and never reordered
      <span key={i} className={`ui-hl-${span.kind}`}>
        {span.text}
      </span>
    ) : (
      span.text
    ),
  );
}

/**
 * Code without background, indented. The plain text paints first with its final line boxes; the
 * grammar chunk loads once per language and the same lines are then re-rendered with colored spans
 * (only font color and weight change, so nothing shifts). Line numbers sit in a separate
 * `select-none` column, so copying gives clean code.
 */
export function CodeBlock({
  code,
  language,
  filename,
  startLine = 1,
  highlight = true,
  streaming = false,
  className,
}: CodeBlockProps) {
  const [loaded, setLoaded] = useState(0);
  const text = code.endsWith("\n") ? code.slice(0, -1) : code;
  const grammar = highlight && !streaming && canHighlight(text) ? grammarFor(language) : null;

  useEffect(() => {
    if (!grammar) return;
    let alive = true;
    ensureGrammar(grammar).then(() => {
      if (alive) setLoaded((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [grammar]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` re-runs the lookup once the grammar arrives
  const spans = useMemo(
    () => (grammar ? highlightCached(grammar, text) : null),
    [grammar, text, loaded],
  );

  const lineCount = useMemo(() => text.split("\n").length, [text]);
  const gutter = useMemo(() => {
    const numbers: number[] = [];
    for (let i = 0; i < lineCount; i++) numbers.push(startLine + i);
    return numbers.join("\n");
  }, [lineCount, startLine]);
  const width = String(startLine + lineCount - 1).length;

  const label = language ? (parseFenceInfo(language).language ?? language) : null;
  const header = [filename, label].filter(Boolean).join(" · ");

  return (
    <div
      className={cx("flex flex-col gap-(--space-4) pl-(--space-code-indent)", className)}
      data-code-block
    >
      {header && <p className="font-mono text-size-xs text-text-dim">{header}</p>}
      {/* Focusable so a keyboard user can scroll a wide block. */}
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scroll container must be reachable by keyboard
        tabIndex={0}
        className="flex gap-(--space-16) overflow-x-auto font-mono text-size-sm leading-(--line-height-ui) text-text-primary"
      >
        <span
          aria-hidden="true"
          className="shrink-0 select-none whitespace-pre text-text-dim"
          style={{ minWidth: `${width}ch` }}
        >
          {gutter}
        </span>
        <code className="whitespace-pre">{spans ? renderSpans(spans) : text}</code>
      </pre>
    </div>
  );
}
