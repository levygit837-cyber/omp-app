import type { FilesDiffResult, FilesReadResult } from "@omp-app/protocol";
import { Button, CodeBlock, DiffView, Notice } from "@omp-app/ui";
import { useEffect, useRef, useState } from "react";
import { describeError } from "../errors";
import { changeFor, diffNotice, languageOf, readNotice, STATUS_WORDS } from "./files-model";
import { usePage } from "./use-files";

type Loaded<T> =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly value: T }
  | { readonly phase: "failed"; readonly message: string };

/**
 * Runs `load` when `key` changes and keeps the latest answer; an answer for an older key is
 * dropped. `key` names everything `load` depends on.
 */
function useLoaded<T>(key: string, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ phase: "loading" });
  const counter = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for what the loader reads
  useEffect(() => {
    const n = ++counter.current;
    loader.current().then(
      (value) => {
        if (counter.current === n) setState({ phase: "ready", value });
      },
      (error: unknown) => {
        if (counter.current === n) setState({ phase: "failed", message: describeError(error) });
      },
    );
    return () => {
      counter.current++;
    };
  }, [key]);
  return state;
}

/**
 * A file of the session's folder, read-only, in the center column. The text is highlighted by
 * language; when git reports the file as changed it can be switched to its diff against HEAD.
 * Both are read again when the page's git state is refreshed.
 */
export function FilePanel({ sessionId, path }: { sessionId: string; path: string }) {
  const page = usePage(sessionId);
  const refreshed = page?.refreshed ?? 0;
  const change =
    page?.status.phase === "ready" && page.status.result.state === "ok"
      ? changeFor(page.status.result.changes, path)
      : undefined;
  const [mode, setMode] = useState<"file" | "diff">("file");
  const changed = change !== undefined;
  // The file ceased to be changed (committed, reverted): back to the text.
  useEffect(() => {
    if (!changed) setMode("file");
  }, [changed]);

  // Paths may hold any character, so the key is the JSON of the parts, not a joined string.
  const file = useLoaded<FilesReadResult>(JSON.stringify([sessionId, path, refreshed]), () =>
    window.omp.files.read(sessionId, path),
  );
  const diff = useLoaded<FilesDiffResult>(
    JSON.stringify([sessionId, path, refreshed, changed]),
    async () => (changed ? window.omp.files.diff(sessionId, path) : { state: "unchanged" }),
  );

  // A deleted file has no text to show: its diff is the whole content.
  const deleted = change?.status === "D";
  const showDiff = changed && (mode === "diff" || deleted);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-panel">
      <div className="flex shrink-0 items-center gap-(--space-12) border-b border-border-hairline px-(--space-20) py-(--space-8)">
        <p
          className="min-w-0 flex-1 truncate font-mono text-size-xs text-text-secondary"
          title={path}
        >
          {path}
        </p>
        {change && (
          <span className="font-mono text-size-xs text-text-dim">
            {STATUS_WORDS[change.status]}
          </span>
        )}
        <span className="text-size-xs text-text-dim">Read-only</span>
        {changed && !deleted && !change.binary && (
          <Button
            variant="ghost"
            aria-pressed={mode === "diff"}
            onClick={() => setMode(mode === "diff" ? "file" : "diff")}
          >
            {mode === "diff" ? "Show file" : "Review diff"}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-(--space-20) py-(--space-16)">
        {showDiff ? <DiffBody state={diff} path={path} /> : <FileBody state={file} path={path} />}
      </div>
    </div>
  );
}

function Message({ children }: { children: string }) {
  return <p className="text-size-sm text-text-dim">{children}</p>;
}

function FileBody({ state, path }: { state: Loaded<FilesReadResult>; path: string }) {
  if (state.phase === "loading") return <Message>Reading the file…</Message>;
  if (state.phase === "failed") {
    return (
      <Notice severity="error" title="Couldn’t read this file">
        {state.message}
      </Notice>
    );
  }
  const notice = readNotice(state.value);
  if (notice !== null || state.value.state !== "ok") return <Message>{notice ?? ""}</Message>;
  return <CodeBlock code={state.value.content} language={languageOf(path)} className="pl-0" />;
}

function DiffBody({ state, path }: { state: Loaded<FilesDiffResult>; path: string }) {
  if (state.phase === "loading") return <Message>Comparing with HEAD…</Message>;
  if (state.phase === "failed") {
    return (
      <Notice severity="error" title="Couldn’t compare this file">
        {state.message}
      </Notice>
    );
  }
  const notice = diffNotice(state.value);
  if (notice !== null || state.value.state !== "ok") return <Message>{notice ?? ""}</Message>;
  return (
    <div className="flex flex-col gap-(--space-8)">
      <DiffView
        lines={state.value.rows}
        path={state.value.from ? `${state.value.from} → ${path}` : path}
      />
      {state.value.truncated && <Message>Only the first lines of this diff are shown.</Message>}
    </div>
  );
}
