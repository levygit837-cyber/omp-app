import type { McpListing, McpServerEntry, SettingScope } from "@omp-app/protocol";
import { Button, cx, PlusIcon, StateMark, Toggle } from "@omp-app/ui";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useDialogFocus } from "./dialog-focus";
import { describeConfigProblem, describeMcpFailure, describeSidecarText } from "./errors";
import {
  draftOf,
  failuresByServer,
  INACTIVE_NOTE_ID,
  inputOf,
  LOCKED_NOTE_ID,
  READ_ONLY_NOTE_ID,
  type ServerDraft,
  serverTarget,
  toggledSentence,
} from "./extensions-model";
import type { McpActions, Outcome } from "./extensions-state";
import { McpForm } from "./McpForm";
import { useWarnings } from "./session-hooks";
import { shortPath } from "./settings-model";

const SCOPE_LABEL: Record<SettingScope, string> = { global: "Global", project: "Project" };

/** Secret values the person asked to see, by `kind:key`. Cleared when the server changes. */
type Revealed = Readonly<Record<string, string>>;

function Reveal({
  label,
  shown,
  masked,
  onReveal,
  onHide,
}: {
  label: string;
  shown: string | undefined;
  masked: string;
  onReveal: () => void;
  onHide: () => void;
}) {
  return (
    <span className="flex items-center gap-(--space-8)">
      <span className="font-mono text-size-sm break-all text-text-primary">{shown ?? masked}</span>
      <Button
        variant="ghost"
        aria-label={`${shown === undefined ? "Reveal" : "Hide"} ${label}`}
        onClick={shown === undefined ? onReveal : onHide}
      >
        {shown === undefined ? "Reveal" : "Hide"}
      </Button>
    </span>
  );
}

/** Where focus goes after a form closes or a server goes away. */
type FocusTarget = { readonly name: string } | "add" | "list";

/**
 * The confirmation before a server leaves its file. It behaves like a dialog: focus moves in (to
 * the safe answer), Tab stays inside, Esc keeps the server, and focus returns to Remove.
 */
function RemoveConfirm({
  name,
  file,
  locked,
  lockedNoteId,
  returnTo,
  onRemove,
  onKeep,
}: {
  name: string;
  file: string;
  locked: boolean;
  lockedNoteId: string | null;
  /** The button that opened this; focus goes back to it. */
  returnTo: RefObject<HTMLElement | null>;
  onRemove: () => void;
  onKeep: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box, onKeep, returnTo);
  return (
    <div
      ref={box}
      role="alertdialog"
      aria-labelledby="mcp-remove-title"
      aria-describedby="mcp-remove-body"
      data-testid="mcp-remove-confirm"
      data-escape-owner=""
      className="flex flex-col gap-(--space-8) border-y border-state-error-border py-(--space-12)"
    >
      <p id="mcp-remove-title" className="text-size-md text-text-primary">
        Remove {name} from {shortPath(file)}?
      </p>
      <p id="mcp-remove-body" className="text-size-sm text-text-secondary">
        The app can’t bring it back. Sessions already open keep it.
      </p>
      <div className="flex items-center gap-(--space-8)">
        <Button
          variant="primary"
          disabled={locked}
          aria-describedby={locked && lockedNoteId ? lockedNoteId : undefined}
          onClick={onRemove}
        >
          Remove server
        </Button>
        <Button data-autofocus="" onClick={onKeep}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

/**
 * What the list does not say by itself: why it is locked or inactive, and that servers from
 * other config files are not here. The ids are what disabled controls point to.
 */
function Notes({ listing }: { listing: McpListing }) {
  return (
    <div className="flex flex-col gap-(--space-6) text-size-xs text-text-dim">
      {listing.locked !== undefined && <p id={LOCKED_NOTE_ID}>{listing.locked}</p>}
      {listing.inactive !== undefined && <p id={INACTIVE_NOTE_ID}>{listing.inactive}</p>}
      <p data-testid="mcp-other-files">
        Servers from other config files (.mcp.json, .claude/mcp.json, .omp/.mcp.json) aren’t shown
        or edited here.
      </p>
    </div>
  );
}

function Detail({
  entry,
  listing,
  failure,
  locked,
  lockedNoteId,
  actions,
  onEdit,
  onDone,
  say,
}: {
  entry: McpServerEntry;
  listing: McpListing;
  failure: string | undefined;
  locked: boolean;
  lockedNoteId: string | null;
  actions: McpActions;
  onEdit: () => void;
  onDone: () => void;
  say: (text: string) => void;
}) {
  const [revealed, setRevealed] = useState<Revealed>({});
  const [revealError, setRevealError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // The parent keys this component on scope and server name, so what was revealed, a pending
  // confirmation and an old error all belong to one server and are dropped with it. `live` keeps
  // a reveal that comes back after the person moved on from landing anywhere.
  const show = async (id: string, kind: "env" | "header" | "url", key?: string) => {
    const result = await actions.reveal(
      entry.name,
      kind === "url" ? { kind } : { kind, key: key ?? "" },
    );
    if (!live.current) return;
    if (result.ok) {
      setRevealError(null);
      setRevealed((r) => ({ ...r, [id]: result.value }));
    } else setRevealError(result.message);
  };
  const hide = (id: string) =>
    setRevealed((r) => {
      const { [id]: _gone, ...rest } = r;
      return rest;
    });

  const run = async (work: Promise<Outcome>, spoken: string, afterwards?: () => void) => {
    const outcome = await work;
    if (!live.current) return;
    setProblem(outcome.refused);
    if (outcome.refused === null) {
      say(spoken);
      afterwards?.();
    }
  };

  const rows: Array<{ term: string; value: React.ReactNode }> = [
    { term: "transport", value: entry.transport },
  ];
  if (entry.transport === "stdio") {
    rows.push({ term: "command", value: entry.command ?? "" });
    if (entry.args.length > 0) rows.push({ term: "args", value: entry.args.join(" ") });
  } else if (entry.url !== undefined) {
    rows.push({
      term: "url",
      value: entry.urlRedacted ? (
        <Reveal
          label={`the URL of ${entry.name}`}
          shown={revealed.url}
          masked={entry.url}
          onReveal={() => void show("url", "url")}
          onHide={() => hide("url")}
        />
      ) : (
        entry.url
      ),
    });
  }
  for (const key of entry.envKeys) {
    rows.push({
      term: `env ${key}`,
      value: (
        <Reveal
          label={`${key} of ${entry.name}`}
          shown={revealed[`env:${key}`]}
          masked="••••••••"
          onReveal={() => void show(`env:${key}`, "env", key)}
          onHide={() => hide(`env:${key}`)}
        />
      ),
    });
  }
  for (const key of entry.headerKeys) {
    rows.push({
      term: `header ${key}`,
      value: (
        <Reveal
          label={`${key} of ${entry.name}`}
          shown={revealed[`header:${key}`]}
          masked="••••••••"
          onReveal={() => void show(`header:${key}`, "header", key)}
          onHide={() => hide(`header:${key}`)}
        />
      ),
    });
  }
  rows.push({
    term: "from",
    value: `${shortPath(listing.file)} · ${SCOPE_LABEL[listing.scope]}`,
  });

  return (
    <section
      aria-labelledby="mcp-detail-title"
      data-testid="mcp-detail"
      className="flex flex-col gap-(--space-16)"
    >
      <div className="flex flex-wrap items-center gap-(--space-12)">
        <h2
          id="mcp-detail-title"
          ref={heading}
          className="font-mono text-size-title font-medium text-text-primary"
        >
          {entry.name}
        </h2>
        <span className="text-size-sm text-text-secondary">
          {entry.enabled ? "On for new sessions" : "Off for new sessions"}
        </span>
        <span className="flex-1" />
        <Button
          disabled={locked}
          aria-describedby={locked && lockedNoteId ? lockedNoteId : undefined}
          onClick={() =>
            void run(
              actions.setEnabled(entry.name, !entry.enabled),
              toggledSentence(entry.name, !entry.enabled),
            )
          }
        >
          {entry.enabled ? "Disable" : "Enable"}
        </Button>
        <Button
          disabled={locked}
          aria-describedby={locked && lockedNoteId ? lockedNoteId : undefined}
          onClick={onEdit}
        >
          Edit
        </Button>
        <Button
          ref={removeButton}
          disabled={locked}
          aria-describedby={locked && lockedNoteId ? lockedNoteId : undefined}
          onClick={() => setConfirming(true)}
        >
          Remove
        </Button>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-(--space-24) gap-y-(--space-8)">
        {rows.map(({ term, value }) => (
          <div key={term} className="contents">
            <dt className="font-mono text-size-sm text-text-dim">{term}</dt>
            <dd className="min-w-0 font-mono text-size-sm break-all text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>

      {(entry.problem ?? failure) !== undefined && (
        <div
          role="alert"
          data-testid="mcp-failure"
          className="flex flex-col gap-(--space-6) border-y border-state-error-border py-(--space-12)"
        >
          <p className="flex items-center gap-(--space-8) text-size-md text-text-primary">
            <StateMark state="error" decorative />
            {entry.problem !== undefined
              ? "omp can’t start this server as it is written"
              : "This server didn’t start in the open session"}
          </p>
          <p className="text-size-sm break-words text-text-secondary">
            {entry.problem !== undefined
              ? describeConfigProblem(entry.problem)
              : describeMcpFailure(failure ?? "")}
          </p>
        </div>
      )}

      {revealError && (
        <p role="alert" className="text-size-sm text-state-error">
          {revealError}
        </p>
      )}

      {confirming && (
        <RemoveConfirm
          name={entry.name}
          file={listing.file}
          locked={locked}
          lockedNoteId={lockedNoteId}
          returnTo={removeButton}
          onKeep={() => setConfirming(false)}
          onRemove={() =>
            void run(
              actions.remove(entry.name),
              `${entry.name} removed. Applies to new sessions.`,
              onDone,
            )
          }
        />
      )}

      {problem && (
        <p role="alert" data-testid="mcp-action-error" className="text-size-sm text-state-error">
          {problem}
        </p>
      )}
    </section>
  );
}

function ServerRow({
  entry,
  scope,
  selected,
  failure,
  locked,
  lockedNoteId,
  onSelect,
  onToggle,
}: {
  entry: McpServerEntry;
  scope: SettingScope;
  selected: boolean;
  failure: string | undefined;
  locked: boolean;
  lockedNoteId: string | null;
  onSelect: () => void;
  onToggle: (next: boolean) => void;
}) {
  const failed = entry.problem !== undefined || failure !== undefined;
  const line = failed
    ? entry.problem !== undefined
      ? describeConfigProblem(entry.problem)
      : describeMcpFailure(failure ?? "")
    : !entry.enabled
      ? "Off for new sessions"
      : serverTarget(entry);
  return (
    <li
      className={cx(
        "flex items-center gap-(--space-8) rounded-sm pr-(--space-12)",
        selected ? "bg-bg-selected" : "hover:bg-bg-hover",
      )}
    >
      <button
        type="button"
        data-server-row={entry.name}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-(--space-10) px-(--space-12) py-(--space-10) text-left"
      >
        <span className="pt-(--space-2)">
          {failed ? (
            <StateMark state="error" label="Failed" />
          ) : !entry.enabled ? (
            <StateMark state="idle" label="Off" />
          ) : (
            <span className="block size-(--size-mark)" aria-hidden="true" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-(--space-2)">
          <span className="flex items-baseline gap-(--space-8)">
            <span className="font-mono text-size-md text-text-primary">{entry.name}</span>
            <span className="font-mono text-size-xs text-text-dim">{entry.transport}</span>
          </span>
          <span
            className={cx(
              "truncate text-size-sm",
              failed ? "text-state-error" : "text-text-secondary",
            )}
          >
            {line}
            <span className="text-text-dim"> · {SCOPE_LABEL[scope]}</span>
          </span>
        </span>
      </button>
      <Toggle
        checked={entry.enabled}
        disabled={locked}
        aria-label={`${entry.name} on new sessions`}
        aria-describedby={locked && lockedNoteId ? lockedNoteId : undefined}
        onCheckedChange={onToggle}
      />
    </li>
  );
}

/** Notice block for a scope that cannot be listed or has nothing in it (Pen XKgsO, UweVm). */
function ScopeNotice({
  listing,
  projectName,
  locked,
  lockedNoteId,
  addRef,
  onAdd,
  onReload,
}: {
  listing: McpListing;
  projectName: string | null;
  locked: boolean;
  lockedNoteId: string | null;
  addRef: React.Ref<HTMLButtonElement>;
  onAdd: () => void;
  onReload: () => void;
}) {
  if (listing.error !== undefined) {
    return (
      <section
        role="alert"
        data-testid="mcp-scope-error"
        className="flex max-w-(--layout-empty-column) flex-col gap-(--space-8)"
      >
        <p className="flex items-center gap-(--space-8) text-size-lg text-text-primary">
          <StateMark state="error" decorative />
          {shortPath(listing.file)} could not be read
        </p>
        <p className="text-size-md text-text-secondary">{describeSidecarText(listing.error)}</p>
        <div>
          <Button onClick={onReload}>Reload</Button>
        </div>
      </section>
    );
  }
  return (
    <section
      data-testid="mcp-empty"
      className="flex max-w-(--layout-empty-column) flex-col gap-(--space-8)"
    >
      <h2 className="text-size-lg text-text-primary">
        {listing.scope === "project"
          ? `No MCP servers in ${projectName ?? "this project"}`
          : "No global MCP servers"}
      </h2>
      <p className="text-size-md text-text-secondary">
        {listing.scope === "project"
          ? "There is no .omp/mcp.json here. Sessions in this project only get the Global servers. Adding one creates the file."
          : `${shortPath(listing.file)} has none. Adding one gives every new session more tools.`}
      </p>
      <div>
        <Button
          ref={addRef}
          variant="primary"
          disabled={locked}
          aria-describedby={locked && lockedNoteId ? lockedNoteId : undefined}
          onClick={onAdd}
        >
          Add server
        </Button>
      </div>
      <Notes listing={listing} />
    </section>
  );
}

export function McpServers({
  listing,
  actions,
  sessionId,
  projectName,
  locked: readOnly,
  query,
  visible,
  say,
}: {
  listing: McpListing;
  actions: McpActions;
  sessionId: string | undefined;
  projectName: string | null;
  /** The app is read-only: every write is refused. */
  locked: boolean;
  query: string;
  /** The servers after the filter. */
  visible: readonly McpServerEntry[];
  say: (text: string) => void;
}) {
  const failures = failuresByServer(useWarnings(sessionId ?? ""));
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [form, setForm] = useState<{ mode: "add" } | { mode: "edit"; draft: ServerDraft } | null>(
    null,
  );
  const [rowProblem, setRowProblem] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<FocusTarget | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  // Writes are refused when the app is read-only or the scope is locked (project file of a
  // session in the home directory). Disabled controls point at the sentence that says why.
  const locked = readOnly || listing.locked !== undefined;
  const lockedNoteId = readOnly
    ? READ_ONLY_NOTE_ID
    : listing.locked !== undefined
      ? LOCKED_NOTE_ID
      : null;

  const selected = visible.find((s) => s.name === selectedName) ?? visible[0] ?? null;
  const unusable = listing.error !== undefined;

  /** Asks for focus to land on `target` once the screen has settled after a close or a removal. */
  const aim = (target: FocusTarget) => {
    focusAfter.current = target;
    setFocusTick((n) => n + 1);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `focusTick` is the trigger
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    const row =
      typeof target === "object"
        ? Array.from(root.current?.querySelectorAll<HTMLElement>("[data-server-row]") ?? []).find(
            (el) => el.dataset.serverRow === target.name,
          )
        : target === "list"
          ? root.current?.querySelector<HTMLElement>("[data-server-row]")
          : undefined;
    (row ?? addButton.current ?? root.current)?.focus();
  }, [focusTick]);

  // A scope change drops an open form: it belonged to the other file.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the scope only
  useEffect(() => {
    setForm(null);
    setRowProblem(null);
  }, [listing.scope]);

  const closeForm = () => {
    aim(form?.mode === "edit" ? { name: form.draft.name } : "add");
    setForm(null);
  };

  const submit = async (draft: ServerDraft): Promise<Outcome> => {
    const input = inputOf(draft);
    const adding = form?.mode === "add";
    const outcome = adding ? await actions.add(input) : await actions.update(input);
    if (outcome.refused === null) {
      setSelectedName(input.name);
      aim({ name: input.name });
      setForm(null);
      say(`${input.name} ${adding ? "added" : "saved"}. Applies to new sessions.`);
    }
    return outcome;
  };

  if (unusable || listing.servers.length === 0) {
    return (
      <div ref={root} tabIndex={-1} className="outline-none">
        {form === null ? (
          <ScopeNotice
            listing={listing}
            projectName={projectName}
            locked={locked}
            lockedNoteId={lockedNoteId}
            addRef={addButton}
            onAdd={() => setForm({ mode: "add" })}
            onReload={actions.reload}
          />
        ) : (
          <div className="max-w-(--layout-empty-column)">
            <McpForm
              mode="add"
              initial={null}
              locked={locked}
              onSubmit={submit}
              onCancel={closeForm}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={root} tabIndex={-1} className="flex min-h-0 flex-1 outline-none">
      <div className="flex w-(--layout-extensions-list) shrink-0 flex-col gap-(--space-8) overflow-y-auto border-r border-border-hairline pr-(--space-16)">
        {visible.length === 0 ? (
          <p role="status" className="py-(--space-12) text-size-md text-text-secondary">
            No server matches “{query.trim()}”.
          </p>
        ) : (
          <ul aria-label="MCP servers" className="flex flex-col gap-(--space-2)">
            {visible.map((entry) => (
              <ServerRow
                key={entry.name}
                entry={entry}
                scope={listing.scope}
                selected={selected?.name === entry.name}
                failure={failures[entry.name]}
                locked={locked}
                lockedNoteId={lockedNoteId}
                onSelect={() => {
                  setSelectedName(entry.name);
                  setForm(null);
                  setRowProblem(null);
                }}
                onToggle={(next) =>
                  void actions.setEnabled(entry.name, next).then((outcome) => {
                    setRowProblem(outcome.refused);
                    say(
                      outcome.refused === null
                        ? toggledSentence(entry.name, next)
                        : outcome.refused,
                    );
                  })
                }
              />
            ))}
          </ul>
        )}
        {rowProblem && (
          <p
            role="alert"
            data-testid="mcp-row-error"
            className="px-(--space-12) text-size-sm text-state-error"
          >
            {rowProblem}
          </p>
        )}
        <div>
          <Button
            ref={addButton}
            variant="ghost"
            disabled={locked}
            aria-describedby={locked && lockedNoteId ? lockedNoteId : undefined}
            onClick={() => setForm({ mode: "add" })}
          >
            <PlusIcon />
            Add server
          </Button>
        </div>
        <Notes listing={listing} />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto pl-(--space-24)">
        {form !== null ? (
          <McpForm
            key={form.mode === "edit" ? form.draft.name : "add"}
            mode={form.mode}
            initial={form.mode === "edit" ? form.draft : null}
            locked={locked}
            onSubmit={submit}
            onCancel={closeForm}
          />
        ) : selected !== null ? (
          <Detail
            key={`${listing.scope}:${selected.name}`}
            entry={selected}
            listing={listing}
            failure={failures[selected.name]}
            locked={locked}
            lockedNoteId={lockedNoteId}
            actions={actions}
            onEdit={() => setForm({ mode: "edit", draft: draftOf(selected) })}
            onDone={() => {
              setSelectedName(null);
              aim("list");
            }}
            say={say}
          />
        ) : null}
      </div>
    </div>
  );
}
