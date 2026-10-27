import { type ToolItem, type ToolStatus, toolItemStatus } from "@omp-app/protocol";
import {
  AskIcon,
  AstGrepIcon,
  BashIcon,
  CheckpointIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EditIcon,
  EvalIcon,
  GlobIcon,
  GrepIcon,
  HistoryIcon,
  JobIcon,
  LspIcon,
  McpIcon,
  MemoryIcon,
  ReadIcon,
  ServiceIcon,
  StateMark,
  SubagentIcon,
  TaskIcon,
  TodoIcon,
  WaitIcon,
  WebSearchIcon,
  WriteIcon,
} from "@omp-app/ui";
import type { ComponentType, SVGProps } from "react";
import { useShownStatus } from "../shown-status";
import { formatElapsed, toolPhrase } from "../tool-phrases";
import { useOpened } from "./opened";
import { PhraseText } from "./Parts";
import { hasBody, ToolBody } from "./ToolOutputView";
import { tokenMs, useNow } from "./use-now";

type Icon = ComponentType<Omit<SVGProps<SVGSVGElement>, "children">>;

/** One icon per tool, from the Pen file. A tool omp adds later falls back to the generic one. */
const ICONS: Record<string, Icon> = {
  read: ReadIcon,
  write: WriteIcon,
  edit: EditIcon,
  grep: GrepIcon,
  ast_grep: AstGrepIcon,
  glob: GlobIcon,
  bash: BashIcon,
  eval: EvalIcon,
  task: TaskIcon,
  subagent: SubagentIcon,
  wait: WaitIcon,
  job: JobIcon,
  ask: AskIcon,
  todo: TodoIcon,
  web_search: WebSearchIcon,
  checkpoint: CheckpointIcon,
  rewind: HistoryIcon,
  lsp: LspIcon,
  recall: MemoryIcon,
  retain: MemoryIcon,
  reflect: MemoryIcon,
};

export function iconFor(tool: string): Icon {
  if (tool.startsWith("mcp__")) return McpIcon;
  return Object.hasOwn(ICONS, tool) ? (ICONS[tool] as Icon) : ServiceIcon;
}

/** Tools that can take minutes: they get a timer once they have run for a while. */
const LONG_RUNNING: Record<string, true> = {
  bash: true,
  task: true,
  eval: true,
  wait: true,
  job: true,
};

/** A run that is no longer streaming cannot have a tool still running: it was cut short. */
export function shownToolStatus(status: ToolStatus, streaming: boolean): ToolStatus {
  return status === "running" && !streaming ? "stopped" : status;
}

/** The leading cell: the tool's icon, or the shape of a failure. Success has no mark. */
function Lead({ tool, status }: { tool: string; status: ToolStatus }) {
  const Icon = iconFor(tool);
  return (
    <span className="flex size-(--size-icon-tool) shrink-0 items-center justify-center text-icon-neutral">
      {status === "failed" ? (
        <StateMark state="error" />
      ) : (
        <Icon className="size-(--size-icon-tool)" />
      )}
    </span>
  );
}

function RunningTimer({ item }: { item: ToolItem }) {
  const now = useNow(true);
  const started = Math.min(
    ...item.calls.filter((c) => c.status === "running").map((c) => c.startedAt),
  );
  const elapsed = now - started;
  if (!(elapsed >= tokenMs("--motion-timer-show-after"))) return null;
  return (
    <span className="font-mono text-size-sm text-text-dim">
      <span aria-hidden="true"> · </span>
      {formatElapsed(elapsed)}
    </span>
  );
}

/**
 * One line of a tool: icon, sentence, quiet facts. Click or Enter opens what the call produced
 * underneath, indented to the start of the text. A line with nothing more to say is plain text,
 * not a button.
 */
export function ToolLine({ sessionId, item }: { sessionId: string; item: ToolItem }) {
  const streaming = useShownStatus(sessionId) === "streaming";
  const status = shownToolStatus(toolItemStatus(item), streaming);
  const phrase = toolPhrase(item, status);
  const [open, toggle] = useOpened(item.id);
  const expandable = status !== "running" && hasBody(item);
  const running = status === "running";
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  const text = (
    <>
      <PhraseText phrase={phrase} />
      {running && LONG_RUNNING[item.tool] === true && (
        <>
          <span className="ml-(--space-8) inline-flex align-middle">
            <StateMark state="running" label="Running" />
          </span>
          <RunningTimer item={item} />
        </>
      )}
    </>
  );

  return (
    <div data-testid="tool-line" data-tool={item.tool} data-status={status}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex min-h-(--size-tool-row) w-full items-start gap-(--space-icon-phrase) rounded-sm text-left text-size-md leading-(--line-height-ui)"
        >
          <Lead tool={item.tool} status={status} />
          <span className="min-w-0 break-words">
            {text}
            <Chevron
              aria-hidden="true"
              className="ml-(--space-6) inline size-(--size-icon-ui) align-text-bottom text-text-dim"
            />
          </span>
        </button>
      ) : (
        <div className="flex min-h-(--size-tool-row) items-start gap-(--space-icon-phrase) text-size-md leading-(--line-height-ui)">
          <Lead tool={item.tool} status={status} />
          <span className="min-w-0 break-words">{text}</span>
        </div>
      )}
      {open && expandable && (
        <div className="pt-(--space-event-inner) pl-(--space-output-indent)">
          <ToolBody item={item} />
        </div>
      )}
    </div>
  );
}
