import type { FileChange, FilesStatusResult } from "@omp-app/protocol";
import { BranchIcon, Button, cx } from "@omp-app/ui";
import { useEffect, useMemo, useState } from "react";
import { SECTION_LABEL } from "../right-panel/styles";
import { showTab } from "../use-tabs";
import { FilesSearch } from "./FilesSearch";
import { FilesTree } from "./FilesTree";
import {
  branchName,
  branchNote,
  dirOf,
  legendOf,
  MAX_SHOWN_CHANGES,
  markersOf,
  nameOf,
  STATUS_WORDS,
} from "./files-model";
import { filesStore, usePage } from "./use-files";

function ChangeRow({
  change,
  selected,
  onOpen,
}: {
  change: FileChange;
  selected: boolean;
  onOpen: () => void;
}) {
  const dir = dirOf(change.path);
  return (
    <li>
      <button
        type="button"
        data-testid="change-row"
        aria-current={selected || undefined}
        onClick={onOpen}
        className={cx(
          "flex h-(--size-tool-row) w-full items-center gap-(--space-8) rounded-sm px-(--space-4) text-left hover:bg-bg-hover",
          selected && "bg-bg-selected",
        )}
      >
        <span
          aria-hidden="true"
          className="w-(--space-12) shrink-0 font-mono text-size-xs text-text-secondary"
        >
          {change.status}
        </span>
        <span className="sr-only">{STATUS_WORDS[change.status]}: </span>
        <span className="shrink-0 font-mono text-size-xs text-text-primary">
          {nameOf(change.path)}
        </span>
        <span className="min-w-0 flex-1 truncate text-size-xs text-text-dim" title={change.path}>
          {dir}
        </span>
        {change.added !== null && change.added > 0 && (
          <span className="shrink-0 font-mono text-size-xs text-diff-add">+{change.added}</span>
        )}
        {change.removed !== null && change.removed > 0 && (
          <span className="shrink-0 font-mono text-size-xs text-diff-remove">
            −{change.removed}
          </span>
        )}
      </button>
    </li>
  );
}

function Head({ result }: { result: Extract<FilesStatusResult, { state: "ok" }> }) {
  const { branch } = result;
  const name = branchName(branch);
  return (
    <header className="flex flex-col gap-(--space-4)">
      <p className="flex items-center gap-(--space-8) font-mono text-size-sm text-text-primary">
        <BranchIcon className="text-icon-neutral" />
        <span className="min-w-0 truncate">{name ?? "No commits yet"}</span>
        {branch.ahead > 0 && <span className="text-text-secondary">↑{branch.ahead}</span>}
        {branch.behind > 0 && <span className="text-text-secondary">↓{branch.behind}</span>}
      </p>
      <p className="text-size-xs text-text-dim">{branchNote(branch)}</p>
    </header>
  );
}

function Changes({
  result,
  openPath,
  onOpen,
}: {
  result: Extract<FilesStatusResult, { state: "ok" }>;
  openPath: string | null;
  onOpen: (path: string) => void;
}) {
  const { changes } = result;
  const shown = changes.slice(0, MAX_SHOWN_CHANGES);
  return (
    <section aria-labelledby="files-changes" className="flex flex-col gap-(--space-8)">
      <div className="flex items-baseline justify-between gap-(--space-8)">
        <h3 id="files-changes" className={SECTION_LABEL}>
          Changes
        </h3>
        <span className="font-mono text-size-xs text-text-secondary">
          {changes.length}
          {result.truncated ? "+" : ""}
        </span>
      </div>
      {changes.length === 0 ? (
        <p className="text-size-sm text-text-dim">No changes against HEAD.</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((change) => (
            <ChangeRow
              key={change.path}
              change={change}
              selected={change.path === openPath}
              onOpen={() => onOpen(change.path)}
            />
          ))}
        </ul>
      )}
      {(changes.length > shown.length || result.truncated) && (
        <p className="text-size-xs text-text-dim">
          Only the first {shown.length} changes are listed. The tree marks the rest.
        </p>
      )}
    </section>
  );
}

/**
 * The right panel's second page: the branch, the files that changed, and the project's tree. It
 * only reads: nothing here stages, commits or discards. A file opens in a tab of the center column.
 */
export function FilesPage({ sessionId, openPath }: { sessionId: string; openPath: string | null }) {
  const page = usePage(sessionId);
  const [query, setQuery] = useState("");

  useEffect(() => {
    filesStore.setVisible(sessionId, true);
    return () => filesStore.setVisible(sessionId, false);
  }, [sessionId]);

  const ok =
    page?.status.phase === "ready" && page.status.result.state === "ok" ? page.status.result : null;
  const markers = useMemo(() => markersOf(ok?.changes ?? []), [ok]);

  const open = (path: string) => {
    showTab(sessionId, { kind: "file", path });
    filesStore.reveal(sessionId, dirOf(path));
  };

  if (!page || page.status.phase === "loading") {
    return (
      <p className="text-size-sm text-text-dim" data-testid="files-loading">
        Reading the project…
      </p>
    );
  }
  if (page.status.phase === "failed") {
    return (
      <div className="flex flex-col items-start gap-(--space-8)" data-testid="files-error">
        <p role="alert" className="text-size-sm text-state-error">
          {page.status.message}
        </p>
        <Button onClick={() => filesStore.refresh(sessionId)}>Try again</Button>
      </div>
    );
  }
  const status = page.status.result;
  if (status.state === "missing") {
    return (
      <p className="text-size-sm text-text-dim" data-testid="files-missing">
        This session’s folder no longer exists.
      </p>
    );
  }
  if (status.state === "timeout") {
    return (
      <div className="flex flex-col items-start gap-(--space-8)" data-testid="files-error">
        <p role="alert" className="text-size-sm text-state-error">
          Git took too long to answer.
        </p>
        <Button onClick={() => filesStore.refresh(sessionId)}>Try again</Button>
      </div>
    );
  }

  const legend = ok ? legendOf(ok.changes) : [];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-(--space-24)">
      {ok ? (
        <>
          <Head result={ok} />
          <Changes result={ok} openPath={openPath} onOpen={open} />
        </>
      ) : (
        <p className="text-size-sm text-text-dim" data-testid="files-not-repo">
          This folder is not a git repository, so there are no changes to show.
        </p>
      )}
      <section aria-labelledby="files-tree" className="flex flex-col gap-(--space-8)">
        <h3 id="files-tree" className={SECTION_LABEL}>
          Project
        </h3>
        <FilesSearch
          sessionId={sessionId}
          query={query}
          onQuery={setQuery}
          onPick={(path, kind) => {
            if (kind === "file") open(path);
            else filesStore.reveal(sessionId, path);
            setQuery("");
          }}
        />
        {query.trim() === "" && (
          <FilesTree
            sessionId={sessionId}
            page={page}
            markers={markers}
            openPath={openPath}
            onOpen={open}
          />
        )}
      </section>
      {legend.length > 0 && (
        <p className="flex flex-wrap gap-x-(--space-12) font-mono text-size-2xs text-text-dim">
          {legend.map((letter) => (
            <span key={letter}>
              {letter} {STATUS_WORDS[letter]}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
