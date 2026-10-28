import { cx, FileIcon, FolderIcon, SearchIcon } from "@omp-app/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeError } from "../errors";
import { debounce, nameOf, searchEscape, searchTarget } from "./files-model";

const SEARCH_MS = 150;

interface Found {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

/**
 * Search by file name over the session's folder (the same listing the `@` references use). With
 * text in the field the results replace the tree; Esc clears the field first and, empty, is left
 * for whatever Esc means elsewhere.
 */
export function FilesSearch({
  sessionId,
  query,
  onQuery,
  onPick,
}: {
  sessionId: string;
  query: string;
  onQuery: (query: string) => void;
  onPick: (path: string, kind: "file" | "dir") => void;
}) {
  const [found, setFound] = useState<Found | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const counter = useRef(0);
  const latest = useRef(query);
  latest.current = query;
  const search = useMemo(
    () =>
      debounce(() => {
        const n = ++counter.current;
        window.omp.session.files(sessionId, latest.current).then(
          (result) => {
            if (counter.current !== n) return;
            setProblem(null);
            setFound(result);
          },
          (error: unknown) => {
            if (counter.current === n) setProblem(describeError(error));
          },
        );
      }, SEARCH_MS),
    [sessionId],
  );
  useEffect(() => {
    if (query.trim() === "") {
      counter.current++;
      setFound(null);
      setProblem(null);
      return;
    }
    search.trigger();
  }, [query, search]);
  useEffect(
    () => () => {
      counter.current++;
      search.cancel();
    },
    [search],
  );

  const searching = query.trim() !== "";
  return (
    <div className="flex flex-col gap-(--space-8)">
      <label className="flex h-(--size-control) items-center gap-(--space-8) rounded-sm border border-border-field px-(--space-8) focus-within:border-focus-ring">
        <SearchIcon className="text-icon-neutral" />
        <span className="sr-only">Search files by name</span>
        <input
          type="search"
          value={query}
          placeholder="Search files"
          data-testid="files-search"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || searchEscape(query) === "pass") return;
            event.preventDefault();
            event.nativeEvent.stopPropagation();
            onQuery("");
          }}
          className="min-w-0 flex-1 bg-transparent text-size-sm text-text-primary outline-none placeholder:text-text-dim"
        />
      </label>
      {searching && (
        <ul aria-label="Search results" className="flex flex-col">
          {problem && <li className="py-(--space-4) text-size-sm text-state-error">{problem}</li>}
          {!problem && found && found.files.length === 0 && (
            <li className="py-(--space-4) text-size-sm text-text-dim">No file matches.</li>
          )}
          {found?.files.map((result) => {
            const target = searchTarget(result);
            return (
              <li key={result}>
                <button
                  type="button"
                  data-testid="search-result"
                  onClick={() => onPick(target.path, target.kind)}
                  className={cx(
                    "flex h-(--size-tool-row) w-full items-center gap-(--space-6) rounded-sm px-(--space-4) text-left hover:bg-bg-hover",
                  )}
                >
                  {target.kind === "dir" ? (
                    <FolderIcon className="text-icon-neutral" />
                  ) : (
                    <FileIcon className="text-icon-neutral" />
                  )}
                  <span className="shrink-0 font-mono text-size-xs text-text-primary">
                    {nameOf(target.path)}
                  </span>
                  <span className="min-w-0 truncate text-size-xs text-text-dim" dir="rtl">
                    <bdi>{target.path}</bdi>
                  </span>
                </button>
              </li>
            );
          })}
          {found?.truncated && (
            <li className="py-(--space-4) text-size-sm text-text-dim">
              The project is large, so some files may be missing. Type more of the name.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
