import { type JobInfo, type SubagentInfo, subagentLive } from "@omp-app/protocol";
import { Button, StateMark } from "@omp-app/ui";
import { useRef } from "react";
import {
  jobMark,
  jobName,
  statusNote,
  subagentMark,
  subagentName,
  tokensLabel,
} from "./delegation-view";
import { askKill, belowOf } from "./kill";
import { Timeline } from "./Timeline";
import { useNow } from "./timeline/use-now";
import { useSubagentView } from "./use-subagent-view";

/** The strip over a panel: what it is, how it stands, and the one thing that can be done to it. */
function PanelHeader({
  mark,
  title,
  facts,
  stop,
}: {
  mark: ReturnType<typeof subagentMark>;
  title: string;
  facts: readonly string[];
  stop: { label: string; onStop: (opener: HTMLElement) => void } | null;
}) {
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className="flex min-h-(--layout-bar-height) shrink-0 items-center gap-(--space-12) border-b border-border-hairline px-(--space-24)">
      <StateMark state={mark.mark} label={mark.label} />
      <h2 className="min-w-0 truncate text-size-md font-medium">{title}</h2>
      <p className="flex shrink-0 gap-(--space-8) font-mono text-size-xs text-text-secondary">
        <span>{mark.label}</span>
        {facts
          // "Stopped" then "stopped" again says nothing new.
          .filter((fact) => fact.toLowerCase() !== mark.label.toLowerCase())
          .map((fact) => (
            <span key={fact} className="text-text-dim">
              · {fact}
            </span>
          ))}
      </p>
      <span className="flex-1" />
      {stop && (
        <Button
          ref={button}
          variant="secondary"
          aria-label={stop.label}
          onClick={() => button.current && stop.onStop(button.current)}
        >
          Stop
        </Button>
      )}
    </div>
  );
}

const LINE = "px-(--space-48) pt-(--space-24) text-size-sm text-text-dim";

/** A subagent's own transcript, read only: there is no input bar because nothing here takes one. */
export function SubagentPanel({ sessionId, sub }: { sessionId: string; sub: SubagentInfo }) {
  const phase = useSubagentView(sub.viewId);
  const live = subagentLive(sub.status);
  const now = useNow(live);
  const mark = subagentMark(sub.status);
  const facts = [
    sub.agent,
    statusNote(sub.status, sub.startedAt, sub.endedAt, now),
    ...(sub.tokens > 0 ? [`${tokensLabel(sub.tokens)} tokens`] : []),
  ].filter((fact) => fact !== "");
  return (
    <>
      <PanelHeader
        mark={mark}
        title={subagentName(sub)}
        facts={facts}
        stop={
          live
            ? {
                label: `Stop ${subagentName(sub)}`,
                onStop: (opener) =>
                  askKill({
                    sessionId,
                    kind: "subagent",
                    id: sub.id,
                    name: subagentName(sub),
                    anchor: belowOf(opener),
                    opener,
                  }),
              }
            : null
        }
      />
      {phase === "ready" ? (
        <Timeline sessionId={sub.viewId} resume={0} />
      ) : (
        <p role="status" className={LINE}>
          {phase === "loading" && "Loading the subagent’s work…"}
          {phase === "lost" && "This subagent’s transcript isn’t available any more."}
          {phase === "failed" && "Couldn’t load this subagent’s transcript."}
        </p>
      )}
      <p className="shrink-0 px-(--space-48) py-(--space-12) text-size-sm text-text-dim">
        Read-only view of the subagent’s work. It reports back to the chat.
      </p>
    </>
  );
}

/** A background job: what omp reports about it. There is no output stream to show, so none is faked. */
export function JobPanel({ sessionId, job }: { sessionId: string; job: JobInfo }) {
  const live = job.status === "running";
  const now = useNow(live);
  const mark = jobMark(job.status);
  const facts = [job.type, statusNote(job.status, job.startTime, job.endTime, now)].filter(
    (fact) => fact !== "",
  );
  return (
    <>
      <PanelHeader
        mark={mark}
        title={jobName(job)}
        facts={facts}
        stop={
          live
            ? {
                label: `Stop ${jobName(job)}`,
                onStop: (opener) =>
                  askKill({
                    sessionId,
                    kind: "job",
                    id: job.id,
                    name: jobName(job),
                    anchor: belowOf(opener),
                    opener,
                  }),
              }
            : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-(--space-48) pt-(--space-24)">
        <dl className="flex w-(--layout-chat-column) max-w-full flex-col gap-(--space-12) text-size-md">
          <div className="flex gap-(--space-16)">
            <dt className="w-(--size-field-narrow) shrink-0 text-text-dim">Command</dt>
            <dd className="min-w-0 font-mono text-size-sm break-words">{job.label}</dd>
          </div>
          {job.progressText && (
            <div className="flex gap-(--space-16)">
              <dt className="w-(--size-field-narrow) shrink-0 text-text-dim">Last output</dt>
              <dd className="min-w-0 font-mono text-size-sm break-words">{job.progressText}</dd>
            </div>
          )}
        </dl>
      </div>
    </>
  );
}
