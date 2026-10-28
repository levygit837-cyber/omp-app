import { ChevronDownIcon, ChevronRightIcon, cx, FileIcon, FolderIcon } from "@omp-app/ui";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import {
  type EntryRow,
  flattenTree,
  type Markers,
  navigateTree,
  STATUS_WORDS,
  type TreeRow,
} from "./files-model";
import type { PageState } from "./files-store";
import { filesStore } from "./use-files";

const LEVEL_INDENT = "var(--space-16)";

function Row({
  row,
  focused,
  selected,
  onFocus,
  onKeyDown,
  onActivate,
}: {
  row: EntryRow;
  focused: boolean;
  selected: boolean;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onActivate: () => void;
}) {
  const isDir = row.entry === "dir";
  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={row.index}
      aria-setsize={row.siblings}
      aria-expanded={isDir ? row.expanded : undefined}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      data-path={row.path}
      data-testid="tree-row"
      onFocus={onFocus}
      onClick={onActivate}
      onKeyDown={onKeyDown}
      style={{ paddingLeft: `calc(${LEVEL_INDENT} * ${row.depth})` }}
      className={cx(
        "flex h-(--size-tool-row) cursor-default items-center gap-(--space-6) rounded-sm pr-(--space-4) text-size-sm outline-none hover:bg-bg-hover focus-visible:outline-(length:--size-focus-ring) focus-visible:outline-focus-ring",
        selected && "bg-bg-selected",
      )}
    >
      <span className="flex size-(--size-icon-ui) shrink-0 items-center justify-center text-text-dim">
        {isDir && (row.expanded ? <ChevronDownIcon /> : <ChevronRightIcon />)}
      </span>
      {isDir ? (
        <FolderIcon className="text-icon-neutral" />
      ) : (
        <FileIcon className="text-icon-neutral" />
      )}
      <span
        className={cx(
          "min-w-0 truncate font-mono text-size-xs",
          selected ? "text-text-primary" : "text-text-secondary",
        )}
      >
        {row.name}
      </span>
      {row.dot && (
        <span
          aria-hidden="true"
          className="size-(--size-dot) shrink-0 rounded-full bg-text-secondary"
        />
      )}
      {row.dot && <span className="sr-only">, contains changes</span>}
      {row.status && (
        <>
          <span aria-hidden="true" className="shrink-0 font-mono text-size-2xs text-text-secondary">
            {row.status}
          </span>
          <span className="sr-only">, {STATUS_WORDS[row.status]}</span>
        </>
      )}
    </div>
  );
}

/**
 * The project's folders and files (WAI-ARIA tree pattern: one tab stop, arrows move, Right/Left
 * open and close, Enter opens a file). Folders load when they are opened.
 */
export function FilesTree({
  sessionId,
  page,
  markers,
  openPath,
  onOpen,
}: {
  sessionId: string;
  page: PageState;
  markers: Markers;
  openPath: string | null;
  onOpen: (path: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const rows = useMemo(
    () => flattenTree(page.dirs, new Set(page.expanded), markers),
    [page.dirs, page.expanded, markers],
  );
  const first = rows.find((row): row is EntryRow => row.kind === "entry")?.path ?? null;
  const tabStop = rows.some((row) => row.kind === "entry" && row.path === focus) ? focus : first;

  const focusRow = (path: string) => {
    setFocus(path);
    // Found by comparing the data attribute: a path can hold quotes and brackets.
    requestAnimationFrame(() => {
      for (const el of Array.from(list.current?.children ?? [])) {
        if (el instanceof HTMLElement && el.dataset.path === path) el.focus();
      }
    });
  };
  const act = (rows: readonly TreeRow[], path: string, key: string): boolean => {
    const move = navigateTree(rows, path, key);
    if (!move) return false;
    if (move.kind === "focus") focusRow(move.path);
    else if (move.kind === "expand") filesStore.toggle(sessionId, move.path, true);
    else if (move.kind === "collapse") filesStore.toggle(sessionId, move.path, false);
    else onOpen(move.path);
    return true;
  };

  return (
    <div ref={list} role="tree" aria-label="Project files" className="flex flex-col">
      {rows.map((row) =>
        row.kind === "note" ? (
          <div
            key={row.key}
            role="none"
            style={{ paddingLeft: `calc(${LEVEL_INDENT} * ${row.depth})` }}
            className={cx(
              "py-(--space-4) text-size-sm",
              row.tone === "error" ? "text-state-error" : "text-text-dim",
            )}
          >
            {row.text}
          </div>
        ) : (
          <Row
            key={row.path}
            row={row}
            focused={row.path === tabStop}
            selected={row.path === openPath}
            onFocus={() => setFocus(row.path)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (act(rows, row.path, event.key)) event.preventDefault();
            }}
            onActivate={() => {
              setFocus(row.path);
              if (row.entry === "dir") filesStore.toggle(sessionId, row.path, !row.expanded);
              else onOpen(row.path);
            }}
          />
        ),
      )}
    </div>
  );
}
