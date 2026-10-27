import type { SettingEntry, SettingScope, SettingsListing } from "@omp-app/protocol";
import { cx, StateMark } from "@omp-app/ui";
import { memo, useEffect, useId, useRef, useState } from "react";
import { Control } from "./settings-controls";
import {
  effectiveChain,
  formatValue,
  isChanged,
  resetTarget,
  SOURCE_LABEL,
} from "./settings-model";
import type { SettingsActions, WriteOutcome } from "./settings-state";

interface RowProps {
  readonly entry: SettingEntry;
  readonly files: SettingsListing["files"];
  readonly scope: SettingScope;
  /** Editing is off for the whole screen (read-only mode, or the project file cannot be read). */
  readonly locked: boolean;
  /** Id of the banner that says why editing is off; disabled controls point at it. */
  readonly lockedNoteId: string | null;
  readonly actions: SettingsActions;
}

/** "Must be 100 to 20000" becomes "Must be 100 to 20000. Not saved." */
function notSaved(message: string): string {
  const sentence = /[.!?]$/.test(message) ? message : `${message}.`;
  return `${sentence} Not saved.`;
}

const META_BUTTON =
  "text-size-sm text-text-secondary hover:text-text-primary disabled:opacity-(--opacity-disabled)";

function Dot({ filled }: { filled: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "block size-(--size-dot) shrink-0 rounded-full",
        filled ? "bg-accent" : "bg-border-default",
      )}
    />
  );
}

function EffectiveValue({
  id,
  entry,
  files,
  scope,
}: {
  id: string;
  entry: SettingEntry;
  files: SettingsListing["files"];
  scope: SettingScope;
}) {
  const rows = effectiveChain(entry, files, scope);
  const winner = rows.find((row) => row.effective);
  return (
    <section
      id={id}
      aria-label={`Effective value of ${entry.label}`}
      className="absolute top-full left-0 z-10 mt-(--space-4) flex w-(--layout-popover) flex-col gap-(--space-10) rounded-md border border-border-default bg-bg-elevated px-(--space-14) py-(--space-12) font-text text-left shadow-menu"
    >
      <p className="font-mono text-size-2xs tracking-caps text-text-dim">
        <span className="uppercase">Effective value</span> · {winner?.value ?? "none"}
      </p>
      {rows.map((row) => (
        <div key={row.source} className="flex items-start gap-(--space-10)">
          <span className="pt-(--space-6)">
            <Dot filled={row.effective} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-(--space-2)">
            <span
              className={cx(
                "text-size-md",
                row.isSet ? "text-text-primary" : "text-text-secondary",
              )}
            >
              {SOURCE_LABEL[row.source]}
            </span>
            <span className="truncate font-mono text-size-2xs text-text-dim">{row.where}</span>
          </span>
          <span
            className={cx(
              "font-mono text-size-sm",
              row.effective ? "text-text-primary" : "text-text-dim",
            )}
          >
            {row.value}
          </span>
        </div>
      ))}
      <p className="text-size-sm text-text-secondary">
        {scope === "project"
          ? "Project wins over Global, Global over the default. "
          : "Global wins over the default. "}
        Reset removes the key from this file.
      </p>
    </section>
  );
}

/** One setting: name, help, where its value comes from, and the control its type calls for. */
export const SettingRow = memo(function SettingRow({
  entry,
  files,
  scope,
  locked,
  lockedNoteId,
  actions,
}: RowProps) {
  const base = useId();
  const labelId = `${base}-label`;
  const descId = `${base}-desc`;
  const errorId = `${base}-error`;
  const noticeId = `${base}-notice`;
  const popoverId = `${base}-source`;
  const [error, setError] = useState<string | null>(null);
  /** The value is saved, but some running sessions kept the old one. */
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const meta = useRef<HTMLDivElement>(null);

  // A refusal belongs to the value that was refused: once the entry is replaced by one the
  // sidecar accepted, or the scope changes, it no longer applies.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on these inputs only
  useEffect(() => {
    setError(null);
    setNotice(null);
  }, [scope, entry.layers.global, entry.layers.project]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !meta.current?.contains(event.target)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const changed = isChanged(entry, scope);
  const disabled = locked || entry.disabledReason !== undefined;
  const revealFrom: SettingScope =
    scope === "project" && !entry.layers.project.set && entry.layers.global.set ? "global" : scope;

  const settle = async (pending: Promise<WriteOutcome>): Promise<string | null> => {
    const { refused, notice: caveat } = await pending;
    setError(refused === null ? null : notSaved(refused));
    setNotice(caveat);
    return refused;
  };

  const describedBy = [
    descId,
    locked ? lockedNoteId : null,
    error ? errorId : null,
    notice ? noticeId : null,
  ]
    .filter(Boolean)
    .join(" ");
  const label = entry.secret ? "set" : formatValue(entry, entry.value);

  return (
    <li className="relative flex items-start gap-(--space-30) border-b border-border-hairline py-(--space-14)">
      <div className="flex min-w-0 flex-1 flex-col gap-(--space-6)">
        <p className="flex items-center gap-(--space-8) text-size-md text-text-primary">
          {changed && <Dot filled />}
          <span id={labelId}>{entry.label}</span>
          {changed && <span className="sr-only">(changed in {SOURCE_LABEL[scope]})</span>}
        </p>
        <div id={descId} className="flex flex-col gap-(--space-4)">
          {entry.description !== "" && (
            <p className="text-size-sm text-text-secondary">{entry.description}</p>
          )}
          {entry.warning && (
            <p className="flex items-start gap-(--space-8) text-size-sm text-state-approval">
              <StateMark state="approval" decorative />
              {entry.warning}
            </p>
          )}
          {entry.disabledReason && (
            <p className="text-size-sm text-text-dim">Unavailable: {entry.disabledReason}</p>
          )}
        </div>
        <div
          ref={meta}
          className="flex flex-wrap items-center gap-x-(--space-8) font-mono text-size-2xs text-text-dim"
        >
          <span>{entry.id}</span>
          <span aria-hidden="true">·</span>
          <button
            ref={trigger}
            type="button"
            aria-expanded={open}
            aria-controls={open ? popoverId : undefined}
            aria-label={`${SOURCE_LABEL[entry.source]}. Show effective value of ${entry.label}: ${label}`}
            onClick={() => setOpen((v) => !v)}
            className={cx(META_BUTTON, "font-text")}
          >
            {SOURCE_LABEL[entry.source]}
          </button>
          {changed && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                disabled={locked}
                aria-describedby={locked ? (lockedNoteId ?? undefined) : undefined}
                onClick={() => void settle(actions.reset(entry.id))}
                className={cx(META_BUTTON, "font-text")}
              >
                Reset to {resetTarget(entry, scope)}
              </button>
            </>
          )}
          {entry.envActive && entry.envName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-text text-size-sm text-text-secondary">
                {entry.envName} overrides this while set
              </span>
            </>
          )}
          {open && <EffectiveValue id={popoverId} entry={entry} files={files} scope={scope} />}
        </div>
      </div>
      <div className="flex w-(--layout-setting-control) shrink-0 flex-col items-end gap-(--space-6)">
        <Control
          entry={entry}
          disabled={disabled}
          invalid={error !== null}
          labelId={labelId}
          describedBy={describedBy}
          commit={(value) => settle(actions.set(entry.id, value))}
          clear={() => settle(actions.reset(entry.id))}
          reject={(message) => setError(notSaved(message))}
          touch={() => {
            setError(null);
            setNotice(null);
          }}
          reveal={() => actions.reveal(entry.id, revealFrom)}
        />
        {error && (
          <p id={errorId} role="alert" className="text-right text-size-sm text-state-error">
            {error}
          </p>
        )}
        {notice && (
          <p id={noticeId} role="status" className="text-right text-size-sm text-text-secondary">
            {notice}
          </p>
        )}
      </div>
    </li>
  );
});
