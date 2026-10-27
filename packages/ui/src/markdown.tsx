import type { Token, Tokens } from "marked";
import { memo, type ReactNode, useCallback, useMemo, useRef } from "react";
import { CodeBlock } from "./code-block";
import { cx } from "./cx";
import { decodeEntities } from "./entities";
import { parseFenceInfo } from "./languages";
import { safeLinkUrl } from "./links";
import { headingSize, isOpenFence, listMarker, splitBlocks } from "./markdown-model";

export interface MarkdownProps {
  text: string;
  /** The text is still growing: the last block may be unfinished. */
  streaming?: boolean;
  /** Called with an http(s) URL when a link is activated. The renderer itself never navigates. */
  onOpenLink?: (url: string) => void;
  className?: string;
}

interface Ctx {
  open: boolean;
  onOpenLink: (url: string) => void;
}

function inline(tokens: readonly Token[] | undefined, ctx: Ctx): ReactNode[] {
  return (tokens ?? []).map((token, i) => inlineToken(token, ctx, i));
}

function inlineToken(token: Token, ctx: Ctx, key: number): ReactNode {
  switch (token.type) {
    case "text": {
      const t = token as Tokens.Text;
      return t.tokens?.length ? (
        <span key={key}>{inline(t.tokens, ctx)}</span>
      ) : (
        decodeEntities(t.text)
      );
    }
    case "escape":
      return (token as Tokens.Escape).text;
    case "strong":
      return (
        <strong key={key} className="font-semibold text-text-primary">
          {inline((token as Tokens.Strong).tokens, ctx)}
        </strong>
      );
    case "em":
      return (
        <em key={key} className="italic">
          {inline((token as Tokens.Em).tokens, ctx)}
        </em>
      );
    case "del":
      return (
        <del key={key} className="line-through">
          {inline((token as Tokens.Del).tokens, ctx)}
        </del>
      );
    case "codespan":
      return (
        <code key={key} className="font-mono text-size-md text-text-primary">
          {(token as Tokens.Codespan).text}
        </code>
      );
    case "br":
      return <br key={key} />;
    case "checkbox":
      return null; // drawn as the list marker
    case "link": {
      const t = token as Tokens.Link;
      const safe = safeLinkUrl(t.href);
      const children = inline(t.tokens, ctx);
      if (!safe) return <span key={key}>{children}</span>;
      return (
        <a
          key={key}
          href={safe.href}
          rel="noreferrer noopener"
          className="text-text-primary underline"
          onClick={(event) => {
            event.preventDefault();
            if (safe.scheme !== "mailto") ctx.onOpenLink(safe.href);
          }}
        >
          {children}
        </a>
      );
    }
    case "image": {
      // Never loaded: CSP and privacy. Alt text plus the address as text.
      const t = token as Tokens.Image;
      return (
        <span key={key}>
          <span className="text-text-secondary">{decodeEntities(t.text) || "image"}</span>{" "}
          <span className="break-all font-mono text-size-md text-text-dim">{t.href}</span>
        </span>
      );
    }
    case "html":
      return (token as Tokens.HTML).text; // escaped by React, never parsed
    default: {
      const t = token as Tokens.Generic;
      return t.tokens ? <span key={key}>{inline(t.tokens, ctx)}</span> : decodeEntities(t.raw);
    }
  }
}

function blocks(tokens: readonly Token[], ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((token, i) => {
    if (token.type === "space" || token.type === "def") return;
    out.push(blockToken(token, ctx, i));
  });
  return out;
}

const CELL = "pr-(--space-30) py-(--space-2) align-top";
const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;

function blockToken(token: Token, ctx: Ctx, key: number): ReactNode {
  switch (token.type) {
    case "paragraph":
      return (
        <p key={key} className="text-size-body leading-(--line-height-prose) text-text-primary">
          {inline((token as Tokens.Paragraph).tokens, ctx)}
        </p>
      );
    case "text": {
      const t = token as Tokens.Text;
      return (
        <span key={key} className="block">
          {t.tokens ? inline(t.tokens, ctx) : decodeEntities(t.text)}
        </span>
      );
    }
    case "heading": {
      const t = token as Tokens.Heading;
      const Tag = `h${Math.min(Math.max(t.depth, 1), 6)}` as "h1";
      return (
        <Tag
          key={key}
          className={cx(
            "font-medium leading-(--line-height-prose) text-text-primary",
            headingSize(t.depth) === "lg" ? "text-size-lg" : "text-size-body",
          )}
        >
          {inline(t.tokens, ctx)}
        </Tag>
      );
    }
    case "code": {
      const t = token as Tokens.Code;
      const info =
        t.codeBlockStyle === "indented"
          ? { language: null, filename: null }
          : parseFenceInfo(t.lang);
      return (
        <CodeBlock
          key={key}
          code={t.text}
          language={info.language}
          filename={info.filename}
          streaming={ctx.open && isOpenFence(t.raw)}
        />
      );
    }
    case "list": {
      const t = token as Tokens.List;
      const Tag = t.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          className="flex flex-col gap-(--space-4) text-size-body leading-(--line-height-prose)"
        >
          {t.items.map((item, index) => {
            const marker = listMarker(t, item, index);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: items are positional
              <li key={index} className="flex gap-(--space-4)">
                <span
                  aria-hidden={marker.label !== null || !t.ordered}
                  className="min-w-(--space-20) shrink-0 text-text-dim"
                >
                  {marker.glyph}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-(--space-4) text-text-primary">
                  {marker.label && <span className="sr-only">{marker.label}: </span>}
                  {blocks(item.tokens, ctx)}
                </div>
              </li>
            );
          })}
        </Tag>
      );
    }
    case "table": {
      const t = token as Tokens.Table;
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-size-md leading-(--line-height-ui)">
            <thead>
              <tr>
                {t.header.map((cell, i) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                    key={i}
                    scope="col"
                    className={cx(
                      CELL,
                      "pb-(--space-6) font-mono text-size-2xs font-normal uppercase tracking-caps text-text-dim",
                      ALIGN[cell.align ?? "left"],
                    )}
                  >
                    {inline(cell.tokens, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                      key={c}
                      className={cx(CELL, "text-text-primary", ALIGN[cell.align ?? "left"])}
                    >
                      {inline(cell.tokens, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="flex flex-col gap-(--space-8) pl-(--space-code-indent) italic text-text-secondary"
        >
          {blocks((token as Tokens.Blockquote).tokens, ctx)}
        </blockquote>
      );
    case "hr":
      return <div key={key} aria-hidden="true" className="h-(--space-8)" />;
    case "html":
      return (
        <p
          key={key}
          className="whitespace-pre-wrap text-size-body leading-(--line-height-prose) text-text-primary"
        >
          {(token as Tokens.HTML).raw.replace(/\s+$/, "")}
        </p>
      );
    default: {
      const t = token as Tokens.Generic;
      return (
        <p key={key} className="text-size-body leading-(--line-height-prose) text-text-primary">
          {t.tokens ? inline(t.tokens, ctx) : decodeEntities(t.raw)}
        </p>
      );
    }
  }
}

interface BlockViewProps {
  token: Token;
  raw: string;
  open: boolean;
  onOpenLink: (url: string) => void;
}

// Equal raw text means an equal token, so a finished block never re-renders while a later one grows.
const BlockView = memo(
  function BlockView({ token, open, onOpenLink }: BlockViewProps) {
    return <>{blockToken(token, { open, onOpenLink }, 0)}</>;
  },
  (a, b) => a.raw === b.raw && a.open === b.open && a.onOpenLink === b.onOpenLink,
);

/**
 * Agent markdown rendered as React elements from the marked lexer (never HTML strings). Cost per
 * delta: lexing is one linear pass over the whole text; rendering touches only the blocks whose raw
 * text changed, in practice the last one.
 */
export function Markdown({ text, streaming = false, onOpenLink, className }: MarkdownProps) {
  const handler = useRef(onOpenLink);
  handler.current = onOpenLink;
  const open = useCallback((url: string) => handler.current?.(url), []);
  const parts = useMemo(() => splitBlocks(text), [text]);
  return (
    <div
      className={cx("flex flex-col gap-(--space-12)", className)}
      data-streaming={streaming || undefined}
    >
      {parts.map((part, i) => (
        <BlockView
          key={part.index}
          token={part.token}
          raw={part.raw}
          open={streaming && i === parts.length - 1}
          onOpenLink={open}
        />
      ))}
    </div>
  );
}
