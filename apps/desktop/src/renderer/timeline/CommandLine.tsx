import type { CommandItem } from "@omp-app/protocol";
import { ChevronDownIcon, ChevronRightIcon, StateMark } from "@omp-app/ui";
import { useContext } from "react";
import { commandPhrase, shownCommandState } from "../command-phrase";
import { EngineContext } from "../shown-status";
import { formatElapsed } from "../tool-phrases";
import { useOpened } from "./opened";
import { PhraseText } from "./Parts";
import { tokenMs, useNow } from "./use-now";

function Elapsed({ since }: { since: number }) {
  const elapsed = useNow(true) - since;
  if (!(elapsed >= tokenMs("--motion-timer-show-after"))) return null;
  return (
    <span className="font-mono text-size-sm text-text-dim">
      <span aria-hidden="true"> · </span>
      {formatElapsed(elapsed)}
    </span>
  );
}

/**
 * A slash command the person ran from the palette: one line like a tool call, and what omp
 * printed underneath when the line is opened. There is no icon for it in the Pen file, so the
 * lead cell is the slash itself, which is also the one thing every command has in common.
 */
export function CommandLine({ item }: { item: CommandItem }) {
  const engine = useContext(EngineContext);
  const state = shownCommandState(item.state, engine);
  const [open, toggle] = useOpened(item.id);
  const expandable = state !== "running" && item.output !== "";
  const running = state === "running";
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  const lead = (
    <span className="flex size-(--size-icon-tool) shrink-0 items-center justify-center text-icon-neutral">
      {state === "failed" ? (
        <StateMark state="error" />
      ) : (
        <span aria-hidden="true" className="font-mono text-size-md">
          /
        </span>
      )}
    </span>
  );
  const text = (
    <>
      <PhraseText phrase={commandPhrase(item, state)} />
      {running && (
        <>
          <span className="ml-(--space-8) inline-flex align-middle">
            <StateMark state="running" label="Running" />
          </span>
          <Elapsed since={item.startedAt} />
        </>
      )}
    </>
  );
  const row =
    "flex min-h-(--size-tool-row) gap-(--space-icon-phrase) text-size-md leading-(--line-height-ui)";

  return (
    <div data-testid="command-line" data-state={state}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className={`${row} w-full items-start rounded-sm text-left`}
        >
          {lead}
          <span className="min-w-0 break-words">
            {text}
            <Chevron
              aria-hidden="true"
              className="ml-(--space-6) inline size-(--size-icon-ui) align-text-bottom text-text-dim"
            />
          </span>
        </button>
      ) : (
        <div className={`${row} items-start`}>
          {lead}
          <span className="min-w-0 break-words">{text}</span>
        </div>
      )}
      {(open && expandable) || (running && item.output !== "") ? (
        <div className="pt-(--space-event-inner) pl-(--space-output-indent)">
          <pre className="font-mono text-size-sm break-words whitespace-pre-wrap text-text-secondary">
            {item.output}
          </pre>
          {item.truncated && (
            <p className="font-mono text-size-sm text-text-dim">… output cut here</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
