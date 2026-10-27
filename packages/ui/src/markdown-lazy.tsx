import { lazy, Suspense } from "react";
import { cx } from "./cx";
import type { MarkdownProps } from "./markdown";

/**
 * `marked` and the renderer are about 60 kB of the first-paint chunk and are needed only once a
 * reply is on screen, so they load as their own chunk. The import starts as soon as this module
 * is evaluated (after the main chunk), which makes the plain-text fallback rare in practice.
 */
const loading = import("./markdown");
const Loaded = lazy(() => loading.then((m) => ({ default: m.Markdown })));

/** The reply as plain text, shown only until the markdown chunk has arrived. */
function Plain({ text, className }: Pick<MarkdownProps, "text" | "className">) {
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

export function Markdown(props: MarkdownProps) {
  return (
    <Suspense fallback={<Plain text={props.text} className={props.className} />}>
      <Loaded {...props} />
    </Suspense>
  );
}
