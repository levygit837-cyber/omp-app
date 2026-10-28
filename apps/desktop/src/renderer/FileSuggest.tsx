import { cx, FileIcon, FolderIcon } from "@omp-app/ui";

export const SUGGEST_ID = "file-suggest";
export const suggestOptionId = (index: number) => `${SUGGEST_ID}-${index}`;

/**
 * The files of the session's folder that match the `@` being typed. The textarea keeps focus and
 * points here with `aria-activedescendant`; arrow keys and Enter are handled by the input bar.
 */
export function FileSuggest({
  files,
  truncated,
  active,
  onPick,
}: {
  /** Null while the first answer is on its way. */
  files: readonly string[] | null;
  /** The folder was too big to search whole: the list may miss files. */
  truncated: boolean;
  active: number;
  onPick: (path: string) => void;
}) {
  return (
    <div className="absolute right-0 bottom-full left-0 z-40 mb-(--space-8) max-h-(--layout-suggest-max) overflow-y-auto rounded-md border border-border-default bg-bg-elevated p-(--space-4) shadow-menu">
      {files === null || files.length === 0 ? (
        <p className="px-(--space-8) py-(--space-6) text-size-sm text-text-dim">
          {files === null
            ? "Searching…"
            : truncated
              ? "No match found. This folder is too big to search whole."
              : "No matching files"}
        </p>
      ) : (
        <div id={SUGGEST_ID} role="listbox" aria-label="Files">
          {files.map((path, index) => (
            // The field keeps focus and handles the keys (arrows, Enter, Tab); this is the pointer path.
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled by the focused textarea
            <div
              key={path}
              id={suggestOptionId(index)}
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              // The field keeps focus: a press must not move it to the list.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(path)}
              className={cx(
                "flex h-(--size-control) cursor-default items-center gap-(--space-8) rounded-sm px-(--space-8) text-size-sm text-text-primary hover:bg-bg-hover",
                index === active && "bg-bg-hover",
              )}
            >
              <span aria-hidden="true" className="flex shrink-0 text-icon-neutral">
                {path.endsWith("/") ? <FolderIcon /> : <FileIcon />}
              </span>
              <span className="min-w-0 truncate font-mono text-size-xs">{path}</span>
            </div>
          ))}
          {truncated && (
            <p className="px-(--space-8) py-(--space-6) text-size-xs text-text-dim">
              This folder is too big to search whole. Some files may be missing.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
