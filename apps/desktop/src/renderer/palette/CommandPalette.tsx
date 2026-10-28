import { Button, cx, Notice, SearchIcon, StateMark } from "@omp-app/ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { describeError } from "../errors";
import { Shortcut } from "../Shortcut";
import { useSessionMark } from "../shown-status";
import {
  type ActionId,
  activate,
  buildView,
  completion,
  confirmFocus,
  describeResults,
  type Entry,
  type Group,
  MODE_PREFIX,
  moveSelection,
  NOTE_TEXT,
  type Outcome,
  type PaletteInput,
  parseQuery,
  type Row,
  rowsOf,
} from "./model";
import { type Range, segments } from "./search";

/** What the host carries out; the palette handles `complete`, `confirm` and `none` itself. */
export type Action = Exclude<
  Outcome,
  { do: "complete" } | { do: "confirm" } | { do: "ask" } | { do: "none" }
>;

/** What a session action asks before it runs, in the words of its confirmation window. */
export interface Asked {
  readonly question: string;
  readonly because: string;
  readonly confirm: string;
  readonly destructive: boolean;
}

const PLACEHOLDER = {
  all: "Search sessions, commands, actions…",
  commands: "Filter commands…",
  actions: "Filter actions…",
} as const;

const CHIP = { all: "", commands: "/ omp commands", actions: "> actions" } as const;

/** The matched part of a label is heavier, as in the frame; nothing else changes. */
function Marked({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  return (
    <>
      {segments(text, ranges).map((part, index) => (
        // Segments of one string never reorder, so the index is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: derived from a string, order is fixed
        <span key={index} className={part.hit ? "font-semibold text-text-primary" : undefined}>
          {part.text}
        </span>
      ))}
    </>
  );
}

function SessionMark({ id }: { id: string }) {
  return <StateMark state={useSessionMark(id)} decorative />;
}

function Dim({ children }: { children: ReactNode }) {
  return <span className="truncate text-text-dim">{children}</span>;
}

function Label({ row }: { row: Row }) {
  const entry: Entry = row.entry;
  switch (entry.kind) {
    case "session":
      return (
        <>
          <SessionMark id={entry.session.id} />
          <span className="truncate text-text-primary">
            <Marked text={entry.session.title} ranges={row.ranges} />
          </span>
          <Dim>{entry.session.project}</Dim>
        </>
      );
    case "action":
      return (
        <>
          <span className="truncate text-text-primary">
            <Marked text={entry.action.label} ranges={row.ranges} />
          </span>
          {entry.action.shortcut && (
            <Shortcut className="ml-auto font-mono text-text-dim">{entry.action.shortcut}</Shortcut>
          )}
        </>
      );
    case "command":
      return (
        <>
          <span className="shrink-0 font-mono text-text-primary">
            /<Marked text={entry.command.name} ranges={row.ranges} />
          </span>
          <Dim>{entry.command.description}</Dim>
        </>
      );
    case "run":
      return (
        <>
          <span className="shrink-0 font-mono text-text-primary">
            /{entry.command.name}
            {entry.args !== "" && ` ${entry.args}`}
          </span>
          <Dim>{entry.args === "" ? (entry.command.hint ?? entry.command.description) : "Run"}</Dim>
        </>
      );
    case "sub":
      return (
        <>
          <span className="shrink-0 font-mono text-text-primary">
            /{entry.command.name} {entry.sub.name}
          </span>
          <Dim>{entry.sub.description ?? entry.sub.usage ?? ""}</Dim>
        </>
      );
    case "prompt":
      return (
        <>
          <span className="truncate text-text-primary">Send “{entry.text}” to the agent</span>
          <Dim>as a new prompt in {entry.sessionTitle}</Dim>
        </>
      );
  }
}

interface ResultsProps {
  groups: readonly Group[];
  selected: number;
  listId: string;
  onHover: (index: number) => void;
  onChoose: (index: number) => void;
}

function Results({ groups, selected, listId, onHover, onChoose }: ResultsProps) {
  let index = 0;
  return (
    <div id={listId} role="listbox" aria-label="Results" className="flex flex-col">
      {groups.map((group) => {
        const headerId = `${listId}-${group.id}`;
        return (
          // A group inside a listbox is the ARIA pattern; a fieldset would not be one.
          // biome-ignore lint/a11y/useSemanticElements: role=group inside role=listbox
          <div key={group.id} role="group" aria-labelledby={headerId}>
            <p
              id={headerId}
              className="px-(--space-10) pt-(--space-12) pb-(--space-6) font-mono text-size-2xs tracking-caps text-text-dim uppercase"
            >
              {group.label}
            </p>
            {group.rows.map((row) => {
              const at = index++;
              const active = at === selected;
              return (
                // The input keeps the focus and points at the active option (combobox pattern),
                // so the option itself is not a tab stop; keys are handled on the dialog.
                // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the dialog
                <div
                  key={row.key}
                  id={`${listId}-row-${at}`}
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  onMouseMove={() => !active && onHover(at)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onChoose(at)}
                  className={cx(
                    "flex h-(--size-palette-row) items-center gap-(--space-10) rounded-sm px-(--space-10) text-size-sm",
                    active && "bg-bg-palette-selected",
                  )}
                >
                  <Label row={row} />
                  {active && !(row.entry.kind === "action" && row.entry.action.shortcut) && (
                    <span aria-hidden="true" className="ml-auto shrink-0 font-mono text-text-dim">
                      ↵
                    </span>
                  )}
                </div>
              );
            })}
            {group.more > 0 && (
              <p
                aria-hidden="true"
                className="px-(--space-10) py-(--space-4) text-size-xs text-text-dim"
              >
                {group.more} more. Keep typing to narrow it down.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Empty({ query, ...rest }: ResultsProps & { query: string }) {
  return (
    <>
      <div className="flex flex-col gap-(--space-4) px-(--space-10) pt-(--space-16) pb-(--space-6)">
        <p className="text-size-sm font-medium text-text-primary">No results for “{query}”</p>
        <p className="text-size-xs text-text-secondary">
          Type <span className="font-mono">/</span> to list omp commands, or{" "}
          <span className="font-mono">&gt;</span> for app actions.
        </p>
      </div>
      <Results {...rest} />
    </>
  );
}

/**
 * The command palette (Pen `NUFjM`): a dialog over the dimmed window with one search field. The
 * field keeps the focus and points at the active row, so typing never leaves it; Tab completes
 * instead of moving focus, which is also what keeps the focus inside the dialog. What each key
 * means is decided in `model.ts`; this file draws it and moves focus.
 */
export function CommandPalette({
  input,
  onDismiss,
  onAction,
  onPrepare,
}: {
  input: PaletteInput;
  /** Esc, a press on the veil. The host puts the focus back where it was. */
  onDismiss: () => void;
  /** Carries out a choice; rejects with the error to show. Resolves when the host has closed. */
  onAction: (action: Action) => Promise<void>;
  /**
   * The question for an action that asks first (Clear context, Delete session, Pause). Rejects
   * with the reason when it cannot run now; the palette shows it as a sentence, with no card.
   */
  onPrepare: (id: ActionId) => Promise<Asked>;
}) {
  const [raw, setRaw] = useState("");
  const [selected, setSelected] = useState(0);
  const [confirm, setConfirm] = useState<{
    /** The bold line; a command's is `Run /line?`. */
    question: ReactNode;
    /** The same line as text, for the screen reader. */
    spoken: string;
    because: string;
    destructive: boolean;
    label: string;
    commit: Action;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const dialogName = useId();

  const view = useMemo(() => buildView(raw, input), [raw, input]);
  const rows = rowsOf(view);
  const at = Math.min(selected, Math.max(rows.length - 1, 0));
  const { mode, text } = parseQuery(raw);
  const note = view.kind === "list" ? view.note : null;

  useEffect(() => {
    if (confirm) (confirmFocus(confirm) === "cancel" ? cancelButton : runButton).current?.focus();
    else field.current?.focus();
  }, [confirm]);

  useEffect(() => {
    setSaid(confirm ? `${confirm.spoken} ${confirm.because}` : describeResults(view));
  }, [view, confirm]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the active row moves
  useEffect(() => {
    document.getElementById(`${listId}-row-${at}`)?.scrollIntoView({ block: "nearest" });
  }, [at, listId, view]);

  const change = (next: string) => {
    setRaw(next);
    setSelected(0);
    setError(null);
  };

  const submit = async (action: Action) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAction(action);
    } catch (e) {
      setConfirm(null);
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const ask = async (id: ActionId) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const asked = await onPrepare(id);
      setConfirm({
        question: asked.question,
        spoken: asked.question,
        because: asked.because,
        destructive: asked.destructive,
        label: asked.confirm,
        commit: { do: "action", id, confirmed: true },
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const outcome = activate(row.entry);
    switch (outcome.do) {
      case "none":
        return;
      case "complete":
        change(outcome.raw);
        return;
      case "confirm":
        setConfirm({
          question: (
            <>
              Run <span className="font-mono">{outcome.line}</span>?
            </>
          ),
          spoken: `Run ${outcome.line}?`,
          because: outcome.because,
          destructive: outcome.destructive,
          label: "Run",
          commit: { do: "run", line: outcome.line, confirmed: true },
        });
        return;
      case "ask":
        void ask(outcome.id);
        return;
      default:
        void submit(outcome);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    // Nothing typed here reaches the window handlers behind the dialog (Esc must not stop a turn
    // or leave Settings), and the key is ours.
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape") {
      take();
      if (confirm) setConfirm(null);
      else onDismiss();
      return;
    }
    if (event.key === "Tab") {
      take();
      if (confirm)
        (document.activeElement === runButton.current ? cancelButton : runButton).current?.focus();
      else {
        const row = rows[at];
        const next = row ? completion(row.entry) : null;
        if (next !== null) change(next);
      }
      return;
    }
    if (confirm || event.target !== field.current) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      take();
      setSelected(moveSelection(at, rows.length, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      take();
      choose(at);
    } else if (event.key === "Backspace" && text === "" && mode !== "all") {
      // The prefix is a chip in front of the field; an empty field gives it up.
      take();
      change("");
    }
  };

  return (
    // The veil is a pointer convenience only; Esc is the keyboard way out (see onKeyDown).
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only dismissal, Esc is the keyboard path
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center bg-veil px-(--space-24) pt-(--layout-palette-top)"
      onMouseDown={(event) => event.target === event.currentTarget && onDismiss()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        onKeyDown={onKeyDown}
        className="flex w-(--layout-palette) max-w-full flex-col overflow-hidden rounded-lg border border-border-default bg-bg-elevated font-text shadow-panel"
      >
        <p id={dialogName} aria-live="polite" aria-atomic="true" className="sr-only">
          {said}
        </p>
        <div className="flex h-(--size-palette-search) shrink-0 items-center gap-(--space-10) border-b border-border-hairline px-(--space-16)">
          <SearchIcon className="text-icon-neutral" aria-hidden="true" />
          {mode !== "all" && (
            <span
              aria-hidden="true"
              className="shrink-0 rounded-xs bg-bg-hover px-(--space-6) py-(--space-2) font-mono text-size-xs text-text-secondary"
            >
              {CHIP[mode]}
            </span>
          )}
          <input
            ref={field}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={confirm || rows.length === 0 ? undefined : `${listId}-row-${at}`}
            aria-label={mode === "all" ? "Search" : `Search ${CHIP[mode].slice(2)}`}
            disabled={confirm !== null}
            value={text}
            placeholder={PLACEHOLDER[mode]}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => change(MODE_PREFIX[mode] + event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-size-body text-text-primary outline-none placeholder:text-text-dim"
          />
          <span aria-hidden="true" className="shrink-0 font-mono text-size-2xs text-text-dim">
            esc
          </span>
        </div>
        <div className="flex max-h-(--layout-palette-list-max) flex-col overflow-y-auto px-(--space-6) pb-(--space-8)">
          {confirm ? (
            <fieldset className="mt-(--space-8) flex flex-col gap-(--space-8) rounded-md bg-bg-palette-selected px-(--space-12) py-(--space-12)">
              <legend className="sr-only">Confirm</legend>
              <p className="text-size-sm font-medium text-text-primary">{confirm.question}</p>
              <p className="text-size-xs text-text-secondary">{confirm.because}</p>
              <div className="flex items-center gap-(--space-12)">
                <Button
                  ref={runButton}
                  variant={confirm.destructive ? "destructive" : "primary"}
                  disabled={busy}
                  onClick={() => void submit(confirm.commit)}
                >
                  {confirm.label}
                </Button>
                <Button ref={cancelButton} variant="ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <span aria-hidden="true" className="font-mono text-size-2xs text-text-dim">
                  esc
                </span>
              </div>
            </fieldset>
          ) : view.kind === "empty" ? (
            <Empty
              query={view.query}
              groups={view.groups}
              selected={at}
              listId={listId}
              onHover={setSelected}
              onChoose={choose}
            />
          ) : (
            <Results
              groups={view.groups}
              selected={at}
              listId={listId}
              onHover={setSelected}
              onChoose={choose}
            />
          )}
          {note && !confirm && (
            <p
              role="status"
              className="flex items-center gap-(--space-8) px-(--space-10) pt-(--space-12) pb-(--space-4) text-size-xs text-text-secondary"
            >
              {note === "loading" && <StateMark state="running" decorative />}
              {NOTE_TEXT[note]}
            </p>
          )}
          {error && (
            <div className="px-(--space-10) pt-(--space-12)">
              <Notice severity="error" title={error} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
