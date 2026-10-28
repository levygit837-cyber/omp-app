import { Button, Markdown, StatusPill } from "@omp-app/ui";
import { useEffect, useRef, useState } from "react";
import { describeError } from "./errors";
import {
  keyLeavesPlan,
  type PlanReading,
  PROPOSAL_HINT,
  pendingProposal,
  planFileName,
  planPage,
} from "./plan-view";
import { usePlan } from "./session-hooks";
import { useShownStatus, useWaiting } from "./shown-status";

const openLink = (url: string) => void window.omp.app.openLink(url);

/**
 * The plan, full height in the chat column. The answer is not given here: the band keeps
 * `Approve and execute` and `Refine plan`, and this view only says that a plan is proposed and
 * where to answer. The file is read again when a proposal arrives or a turn ends, because omp
 * emits no event when the agent writes it.
 */
export function PlanView({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const plan = usePlan(sessionId);
  const waiting = useWaiting(sessionId);
  const status = useShownStatus(sessionId);
  const proposal = pendingProposal(plan?.enabled ?? false, waiting);
  const root = useRef<HTMLElement>(null);
  const [reading, setReading] = useState<PlanReading>({ status: "loading" });
  const proposalId = proposal?.id;
  const enabled = plan?.enabled ?? false;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the three values are the reasons to read again, not inputs of the read
  useEffect(() => {
    let current = true;
    window.omp.session
      .readPlan(sessionId)
      .then((result) => current && setReading({ status: "done", result }))
      .catch((e: unknown) => current && setReading({ status: "failed", text: describeError(e) }));
    return () => {
      current = false;
    };
  }, [sessionId, proposalId, enabled, status]);

  const escClaimed = proposal !== undefined || waiting.length > 0 || status === "streaming";
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (keyLeavesPlan(event.key, root.current?.closest("[inert]") != null, escClaimed)) onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escClaimed, onBack]);

  const page = planPage(reading);
  return (
    <section
      ref={root}
      data-testid="plan-view"
      aria-label="Plan"
      className="absolute inset-0 flex flex-col bg-bg-base"
    >
      <div className="flex items-center gap-(--space-12) px-(--space-48) pt-(--space-10) pb-(--space-10)">
        <Button variant="ghost" data-testid="plan-back" onClick={onBack}>
          Back to chat
        </Button>
        {page.kind === "plan" && (
          <p className="truncate font-mono text-size-xs text-text-dim">{planFileName(page.file)}</p>
        )}
        <span className="flex-1" />
        {proposal ? (
          <StatusPill data-testid="plan-proposed">Plan proposed</StatusPill>
        ) : page.kind === "plan" && page.earlier ? (
          // omp re-entered plan mode on a plan it already had: it is not this round's proposal.
          <p
            data-testid="plan-earlier"
            className="font-mono text-size-2xs tracking-caps text-text-dim uppercase"
          >
            Earlier plan
          </p>
        ) : (
          <p className="font-mono text-size-2xs tracking-caps text-text-dim uppercase">
            {enabled ? "Plan mode" : "Plan mode off"}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-(--space-48)">
        <div className="mx-auto w-(--layout-chat-column) max-w-full pb-(--space-24)">
          {page.kind === "plan" && (
            <div
              data-testid="plan-content"
              className="text-size-body leading-(--line-height-prose) break-words"
            >
              <Markdown text={page.content} onOpenLink={openLink} />
            </div>
          )}
          {page.kind === "loading" && (
            <p className="text-size-sm text-text-dim">Reading the plan…</p>
          )}
          {(page.kind === "empty" || page.kind === "problem") && (
            <p
              data-testid="plan-note"
              role={page.kind === "problem" ? "alert" : undefined}
              className={`text-size-body ${page.kind === "problem" ? "text-state-error" : "text-text-secondary"}`}
            >
              {page.text}
            </p>
          )}
        </div>
      </div>
      {proposal && (
        <p
          data-testid="plan-hint"
          className="px-(--space-48) pt-(--space-8) pb-(--space-4) text-center font-mono text-size-xs text-text-dim"
        >
          {PROPOSAL_HINT}
        </p>
      )}
    </section>
  );
}
