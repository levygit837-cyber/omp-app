import type {
  FileDiff,
  ListEntry,
  MatchFile,
  SubagentRow,
  TodoPhase,
  ToolCall,
  ToolItem,
  ToolOutput,
} from "@omp-app/protocol";
import { DiffView, StateMark } from "@omp-app/ui";
import { formatDuration } from "../tool-phrases";
import { Branch } from "./Parts";

/**
 * What a call shows when its line is expanded, per `w4Rzd`: a tree of matches, a grouped path
 * list, a numbered diff, a command with its tail, subagents, a checklist. Indented under the
 * text of the line, no background, nothing pushed to the right.
 */
const MORE = "text-text-dim";

function Omitted({ count, noun }: { count: number; noun: string }) {
  if (count <= 0) return null;
  return <p className={MORE}>{`… ${count} more ${noun}`}</p>;
}

function Diffs({ files }: { files: readonly FileDiff[] }) {
  return (
    <div className="flex flex-col gap-(--space-10)">
      {files.map((file) => (
        <div key={`${file.path}:${file.op}`} className="flex flex-col gap-(--space-4)">
          <DiffView
            path={file.movedFrom ? `${file.movedFrom} → ${file.path}` : file.path}
            lines={file.rows}
          />
          <Omitted count={file.rowsOmitted} noun="rows" />
        </div>
      ))}
    </div>
  );
}

function Matches({ files, omitted }: { files: readonly MatchFile[]; omitted: number }) {
  return (
    <div className="flex flex-col gap-(--space-6) font-mono text-size-sm">
      {files.map((file) => (
        <div key={file.path} className="flex flex-col">
          <p>
            <span className="text-text-primary">{file.path}</span>
            <span className="text-text-dim">{` · ${file.count}`}</span>
          </p>
          {file.lines.map((line, i) => (
            <p key={line.line} className="flex gap-(--space-8)">
              <Branch last={i === file.lines.length - 1} />
              <span className="text-text-dim">{line.line}</span>
              <span className="min-w-0 break-words whitespace-pre-wrap text-text-secondary">
                {line.text}
              </span>
            </p>
          ))}
        </div>
      ))}
      <Omitted count={omitted} noun="files" />
    </div>
  );
}

function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "" : path.slice(0, at + 1);
}

function Paths({ paths, count }: { paths: readonly string[]; count: number }) {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const dir = dirname(path);
    groups.set(dir, [...(groups.get(dir) ?? []), path.slice(dir.length)]);
  }
  return (
    <div className="flex flex-col gap-(--space-6) font-mono text-size-sm">
      {[...groups].map(([dir, names]) => (
        <div key={dir} className="flex flex-col">
          {dir && <p className="text-text-secondary">{dir}</p>}
          {names.map((name, i) => (
            <p key={name} className="flex gap-(--space-8)">
              {dir && <Branch last={i === names.length - 1} />}
              <span className="text-text-primary">{name}</span>
            </p>
          ))}
        </div>
      ))}
      <Omitted count={count - paths.length} noun="entries" />
    </div>
  );
}

function Shell({ call, out }: { call: ToolCall; out: Extract<ToolOutput, { kind: "shell" }> }) {
  const footer = [
    out.timedOut ? "timed out" : out.exitCode !== undefined ? `exit ${out.exitCode}` : null,
    out.wallTimeMs !== undefined ? formatDuration(out.wallTimeMs) : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col font-mono text-size-sm">
      {call.target && (
        <p className="break-words whitespace-pre-wrap text-text-primary">
          <span aria-hidden="true" className="text-text-dim">
            {"$ "}
          </span>
          {call.target}
        </p>
      )}
      {out.linesOmitted > 0 && <p className={MORE}>{`… ${out.linesOmitted} lines above`}</p>}
      {out.lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: output lines repeat; position is their identity
        <p key={i} className="break-words whitespace-pre-wrap text-text-secondary">
          {line}
        </p>
      ))}
      {footer.length > 0 && <p className={MORE}>{footer.join(" · ")}</p>}
    </div>
  );
}

function Subagents({ agents }: { agents: readonly SubagentRow[] }) {
  return (
    <div className="flex flex-col gap-(--space-4) text-size-sm">
      {agents.map((agent, i) => (
        <div key={agent.id} className="flex gap-(--space-8)">
          <Branch last={i === agents.length - 1} />
          <div className="flex min-w-0 flex-col">
            <p className="flex items-center gap-(--space-8)">
              {agent.status === "running" && <StateMark state="running" decorative />}
              {(agent.status === "failed" || agent.status === "aborted") && (
                <StateMark state="error" decorative />
              )}
              <span className="font-mono text-text-primary">{agent.agent}</span>
              <span className="text-text-secondary">{agent.description}</span>
            </p>
            <p className="text-text-dim">
              {[
                agent.status === "aborted" ? "stopped" : null,
                agent.durationMs !== undefined ? formatDuration(agent.durationMs) : null,
                agent.tokens !== undefined ? `${(agent.tokens / 1000).toFixed(1)}k tokens` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function Checklist({ phases }: { phases: readonly TodoPhase[] }) {
  return (
    <div className="flex flex-col gap-(--space-4) text-size-sm">
      {phases.flatMap((phase) =>
        phase.tasks.map((task) => (
          <p key={`${phase.name}:${task.content}`} className="flex items-center gap-(--space-8)">
            {task.status === "in_progress" ? (
              <StateMark state="running" decorative />
            ) : task.status === "pending" ? (
              <StateMark state="idle" decorative />
            ) : task.status === "blocked" ? (
              <StateMark state="approval" decorative />
            ) : null}
            <span
              className={
                task.status === "completed" || task.status === "abandoned"
                  ? "text-text-dim line-through"
                  : "text-text-primary"
              }
            >
              <span className="sr-only">{`${task.status.replace("_", " ")}: `}</span>
              {task.content}
            </span>
          </p>
        )),
      )}
    </div>
  );
}

function Entries({ entries, total }: { entries: readonly ListEntry[]; total: number }) {
  return (
    <div className="flex flex-col text-size-sm">
      {entries.map((entry, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: titles can repeat; a result list is static
        <div key={i} className="flex gap-(--space-8)">
          <Branch last={i === entries.length - 1 && total <= entries.length} />
          <div className="flex min-w-0 flex-col">
            <p className="text-text-primary">{entry.title}</p>
            {entry.note && <p className="font-mono text-size-xs text-text-dim">{entry.note}</p>}
          </div>
        </div>
      ))}
      <Omitted count={total - entries.length} noun="results" />
    </div>
  );
}

function OutputOf({ call, out }: { call: ToolCall; out: ToolOutput }) {
  switch (out.kind) {
    case "diff":
      return <Diffs files={out.files} />;
    case "shell":
      return <Shell call={call} out={out} />;
    case "matches":
      return <Matches files={out.files} omitted={out.filesOmitted} />;
    case "paths":
      return <Paths paths={out.paths} count={out.count} />;
    case "todo":
      return <Checklist phases={out.phases} />;
    case "subagents":
      return <Subagents agents={out.agents} />;
    case "list":
      return <Entries entries={out.entries} total={out.total} />;
    case "text":
      return (
        <div className="font-mono text-size-sm text-text-secondary">
          <p className="break-words whitespace-pre-wrap">{out.text}</p>
          <Omitted count={out.linesOmitted} noun="lines" />
        </div>
      );
  }
}

/** A single-file read lists only the file the sentence already names: nothing more to show. */
function repeatsSentence(item: ToolItem, call: ToolCall): boolean {
  return (
    item.calls.length === 1 &&
    call.output?.kind === "paths" &&
    !call.output.directory &&
    call.output.paths.length <= 1
  );
}

/** Does expanding this line show anything the sentence did not already say? */
export function hasBody(item: ToolItem): boolean {
  return item.calls.some(
    (c) =>
      (c.output !== undefined && c.status !== "running" && !repeatsSentence(item, c)) ||
      c.output?.kind === "shell" ||
      c.error !== undefined ||
      (item.calls.length > 1 && c.target !== undefined),
  );
}

export function ToolBody({ item }: { item: ToolItem }) {
  const grouped = item.calls.length > 1;
  return (
    <div className="flex flex-col gap-(--space-10)">
      {item.calls.map((call) => (
        <div key={call.toolCallId} className="flex flex-col gap-(--space-4)">
          {grouped && item.tool !== "bash" && call.target && (
            <p className="font-mono text-size-sm text-text-primary">{call.target}</p>
          )}
          {call.output &&
          !repeatsSentence(item, call) &&
          (call.status !== "running" || call.output.kind === "shell") ? (
            <OutputOf call={call} out={call.output} />
          ) : null}
          {call.status === "failed" && call.error && call.output?.kind !== "shell" && (
            <p className="break-words whitespace-pre-wrap text-size-sm text-text-secondary">
              {call.error}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
