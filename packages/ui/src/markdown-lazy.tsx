import { type ComponentType, lazy, Suspense } from "react";
import { cx } from "./cx";
import type { MarkdownProps } from "./markdown";

/** The reply as plain text: shown until the markdown chunk has arrived, and for good if it cannot. */
export function Plain({ text, className }: Pick<MarkdownProps, "text" | "className">) {
  return (
    <p
      className={cx(
        "text-size-body leading-(--line-height-prose) whitespace-pre-wrap text-text-primary",
        className,
      )}
    >
      {text}
    </p>
  );
}

/**
 * A chunk that fails to load must not reject into `lazy()`: React rethrows it during render and
 * with no error boundary above, the whole window goes blank. The reply is still readable as text.
 */
export function resolveMarkdown(
  loading: Promise<{ Markdown: ComponentType<MarkdownProps> }>,
): Promise<{ default: ComponentType<MarkdownProps> }> {
  return loading.then(
    (m) => ({ default: m.Markdown }),
    () => ({ default: Plain }),
  );
}

/**
 * `marked` and the renderer are about 60 kB of the first-paint chunk and are needed only once a
 * reply is on screen, so they load as their own chunk. The import starts as soon as this module
 * is evaluated (after the main chunk), which makes the plain-text fallback rare in practice.
 */
const loading = resolveMarkdown(import("./markdown"));
const Loaded = lazy(() => loading);

export function Markdown(props: MarkdownProps) {
  return (
    <Suspense fallback={<Plain text={props.text} className={props.className} />}>
      <Loaded {...props} />
    </Suspense>
  );
}
