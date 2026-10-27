import type { SettingEntry } from "@omp-app/protocol";
import { ChevronDownIcon, ChevronRightIcon, cx, PlusIcon, Toggle } from "@omp-app/ui";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { jsonText, type Parsed, parseJsonInput, parseNumberInput } from "./settings-model";

/** What a row hands to the control it renders. */
export interface ControlProps {
  readonly entry: SettingEntry;
  /** Editing is off: read-only mode, an unmet condition, or an unreadable project file. */
  readonly disabled: boolean;
  readonly invalid: boolean;
  /** Ids of the elements that name and describe the control. */
  readonly labelId: string;
  readonly describedBy: string;
  /** Saves a value. Resolves with the reason it was refused, or `null`. */
  readonly commit: (value: unknown) => Promise<string | null>;
  /** Removes the key from the scope's file. */
  readonly clear: () => Promise<string | null>;
  /** Reports a value that never left the renderer (not a number, not JSON). */
  readonly reject: (message: string) => void;
  /** The user started editing again: the last error no longer applies. */
  readonly touch: () => void;
  /** The stored value of a secret, from the file that sets it. */
  readonly reveal: () => Promise<Parsed<string>>;
}

const FIELD =
  "h-(--size-field) w-full rounded-sm border bg-bg-base px-(--space-10) font-mono text-size-sm text-text-primary placeholder:text-text-dim disabled:opacity-(--opacity-disabled)";

function fieldBorder(invalid: boolean): string {
  return invalid ? "border-state-error" : "border-border-field";
}

/** A draft that follows the saved value whenever the saved value changes underneath it. */
function useDraft(committed: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(committed);
  const [seen, setSeen] = useState(committed);
  if (seen !== committed) {
    setSeen(committed);
    setDraft(committed);
  }
  return [draft, setDraft];
}

/** Runs a save and holds the control off while it is in flight, so edits cannot race. */
function usePending(): [boolean, (save: () => Promise<unknown>) => void] {
  const [pending, setPending] = useState(false);
  return [
    pending,
    (save) => {
      setPending(true);
      void save().finally(() => setPending(false));
    },
  ];
}

function BooleanControl({ entry, disabled, labelId, describedBy, commit, touch }: ControlProps) {
  const [pending, run] = usePending();
  return (
    <Toggle
      checked={entry.value === true}
      disabled={disabled || pending}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      onCheckedChange={(next) => {
        touch();
        run(() => commit(next));
      }}
    />
  );
}

interface Choice {
  readonly value: string;
  readonly label: string;
}

function Select({
  value,
  choices,
  disabled,
  invalid,
  labelId,
  describedBy,
  onPick,
}: {
  value: string;
  choices: readonly Choice[];
  disabled: boolean;
  invalid: boolean;
  labelId: string;
  describedBy: string;
  onPick: (value: string) => void;
}) {
  // A value the registry does not list (set by hand in the file) stays selectable as itself.
  const known = choices.some((choice) => choice.value === value);
  return (
    <div className="relative w-full">
      <select
        value={value}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        onChange={(event) => onPick(event.target.value)}
        className={cx(FIELD, fieldBorder(invalid), "appearance-none pr-(--space-30)")}
      >
        {!known && <option value={value}>{value}</option>}
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-(--space-10) -translate-y-1/2 text-icon-neutral" />
    </div>
  );
}

function ChoiceControl({
  entry,
  disabled,
  invalid,
  labelId,
  describedBy,
  commit,
  touch,
}: ControlProps) {
  const [pending, run] = usePending();
  const isNumber = entry.type === "number";
  const current = entry.value === null || entry.value === undefined ? "" : String(entry.value);
  const choices = entry.options ?? [];
  return (
    <Select
      value={current}
      choices={choices}
      disabled={disabled || pending}
      invalid={invalid}
      labelId={labelId}
      describedBy={describedBy}
      onPick={(picked) => {
        touch();
        run(() => commit(isNumber ? Number(picked) : picked));
      }}
    />
  );
}

function NumberControl({
  entry,
  disabled,
  invalid,
  labelId,
  describedBy,
  commit,
  reject,
  touch,
}: ControlProps) {
  const unitId = useId();
  const committed = typeof entry.value === "number" ? String(entry.value) : "";
  const [draft, setDraft] = useDraft(committed);
  const [pending, run] = usePending();
  const save = () => {
    if (draft === committed) return;
    const parsed = parseNumberInput(draft);
    if (!parsed.ok) reject(parsed.message);
    else run(() => commit(parsed.value));
  };
  return (
    <div className="relative w-(--size-field-narrow)">
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        disabled={disabled || pending}
        aria-labelledby={labelId}
        aria-describedby={entry.unit ? `${describedBy} ${unitId}` : describedBy}
        aria-invalid={invalid}
        onChange={(event) => {
          touch();
          setDraft(event.target.value);
        }}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
          if (event.key === "Escape") setDraft(committed);
        }}
        className={cx(FIELD, fieldBorder(invalid), entry.unit && "pr-(--space-30)")}
      />
      {entry.unit && (
        <span
          id={unitId}
          className="pointer-events-none absolute top-1/2 right-(--space-10) -translate-y-1/2 font-mono text-size-xs text-text-secondary"
        >
          {entry.unit}
        </span>
      )}
    </div>
  );
}

function TextControl({
  entry,
  disabled,
  invalid,
  labelId,
  describedBy,
  commit,
  touch,
}: ControlProps) {
  const committed = typeof entry.value === "string" ? entry.value : "";
  const [draft, setDraft] = useDraft(committed);
  const [pending, run] = usePending();
  const save = () => {
    if (draft !== committed) run(() => commit(draft));
  };
  return (
    <input
      type="text"
      value={draft}
      disabled={disabled || pending}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      spellCheck={false}
      onChange={(event) => {
        touch();
        setDraft(event.target.value);
      }}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
        if (event.key === "Escape") setDraft(committed);
      }}
      className={cx(FIELD, fieldBorder(invalid))}
    />
  );
}

const CHIP =
  "inline-flex items-center gap-(--space-6) rounded-sm border border-border-default px-(--space-8) py-(--space-4) font-mono text-size-xs text-text-primary";
const CHIP_BUTTON =
  "inline-flex items-center text-text-secondary hover:text-text-primary disabled:opacity-(--opacity-disabled)";

/** The list of choices behind a chips "Add": a real button that opens real buttons. */
function AddChoice({
  label,
  choices,
  disabled,
  onPick,
}: {
  label: string;
  choices: readonly Choice[];
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
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

  return (
    <span ref={root} className="relative inline-flex">
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Add to ${label}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-(--space-4) text-size-sm text-text-secondary hover:text-text-primary disabled:opacity-(--opacity-disabled)"
      >
        <PlusIcon />
        Add
      </button>
      {open && (
        <ul
          id={listId}
          aria-label={`Choices for ${label}`}
          className="absolute top-full right-0 z-10 mt-(--space-4) flex min-w-(--size-field-narrow) flex-col rounded-md border border-border-default bg-bg-elevated py-(--space-4) text-left shadow-menu"
        >
          {choices.map((choice) => (
            <li key={choice.value}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  onPick(choice.value);
                }}
                className="w-full px-(--space-10) py-(--space-6) text-left font-text text-size-sm text-text-primary hover:bg-bg-hover"
              >
                {choice.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

function ChipsControl({ entry, disabled, labelId, describedBy, commit, touch }: ControlProps) {
  const [pending, run] = usePending();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const items = Array.isArray(entry.value)
    ? entry.value.filter((item): item is string => typeof item === "string")
    : [];
  const labels = new Map((entry.options ?? []).map((option) => [option.value, option.label]));
  const remaining = (entry.options ?? []).filter((option) => !items.includes(option.value));
  const off = disabled || pending;
  const save = (next: string[]) => {
    touch();
    run(() => commit(next));
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...items];
    const [taken] = next.splice(index, 1);
    if (taken === undefined) return;
    next.splice(index + by, 0, taken);
    save(next);
  };
  /** Backspace or Delete on a chip's button removes that chip, like in a tag field. */
  const removeOnKey = (item: string) => (event: KeyboardEvent) => {
    if (off || (event.key !== "Backspace" && event.key !== "Delete")) return;
    event.preventDefault();
    save(items.filter((other) => other !== item));
  };
  const addDraft = () => {
    const value = draft.trim();
    setAdding(false);
    setDraft("");
    if (value !== "" && !items.includes(value)) save([...items, value]);
  };
  return (
    <ul
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      className="flex flex-wrap items-center justify-end gap-(--space-6)"
    >
      {items.map((item, index) => {
        const name = labels.get(item) ?? item;
        return (
          <li key={item} className={CHIP}>
            {entry.ordered && (
              <>
                <span className="text-text-dim">{index + 1}</span>
                <button
                  type="button"
                  aria-label={`Move ${name} earlier`}
                  disabled={off || index === 0}
                  onClick={() => move(index, -1)}
                  onKeyDown={removeOnKey(item)}
                  className={CHIP_BUTTON}
                >
                  <ChevronRightIcon className="rotate-180" />
                </button>
              </>
            )}
            <span>{name}</span>
            {entry.ordered && (
              <button
                type="button"
                aria-label={`Move ${name} later`}
                disabled={off || index === items.length - 1}
                onClick={() => move(index, 1)}
                onKeyDown={removeOnKey(item)}
                className={CHIP_BUTTON}
              >
                <ChevronRightIcon />
              </button>
            )}
            <button
              type="button"
              aria-label={`Remove ${name}`}
              disabled={off}
              onClick={() => save(items.filter((other) => other !== item))}
              onKeyDown={removeOnKey(item)}
              className={CHIP_BUTTON}
            >
              ×
            </button>
          </li>
        );
      })}
      <li>
        {entry.options ? (
          remaining.length > 0 && (
            <AddChoice
              label={entry.label}
              choices={remaining}
              disabled={off}
              onPick={(value) => save([...items, value])}
            />
          )
        ) : adding ? (
          <input
            // The field exists only because the user asked to add: focus belongs in it.
            // biome-ignore lint/a11y/noAutofocus: opened by an explicit "Add" press
            autoFocus
            type="text"
            value={draft}
            spellCheck={false}
            aria-label={`New entry for ${entry.label}`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={addDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") addDraft();
              if (event.key === "Escape") {
                setDraft("");
                setAdding(false);
              }
            }}
            className="h-(--size-control) w-(--size-field-narrow) rounded-sm border border-border-field bg-bg-base px-(--space-8) font-mono text-size-xs text-text-primary"
          />
        ) : (
          <button
            type="button"
            disabled={off}
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-(--space-4) text-size-sm text-text-secondary hover:text-text-primary disabled:opacity-(--opacity-disabled)"
          >
            <PlusIcon />
            Add
          </button>
        )}
      </li>
    </ul>
  );
}

function KeyValueControl({ entry, disabled, labelId, describedBy, commit, touch }: ControlProps) {
  const [pending, run] = usePending();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const valueField = useRef<HTMLInputElement>(null);
  const rows =
    typeof entry.value === "object" && entry.value !== null && !Array.isArray(entry.value)
      ? Object.entries(entry.value).map(([k, v]) => [k, String(v)] as const)
      : [];
  const off = disabled || pending;
  const save = (next: ReadonlyArray<readonly [string, string]>) => {
    touch();
    run(() => commit(Object.fromEntries(next)));
  };
  const add = () => {
    const name = key.trim();
    if (name === "" || value.trim() === "") return;
    save([...rows.filter(([existing]) => existing !== name), [name, value.trim()]]);
    setKey("");
    setValue("");
  };
  return (
    <fieldset
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      className="flex w-full min-w-0 flex-col gap-(--space-6)"
    >
      {rows.map(([name, current]) => (
        <div key={name} className="flex items-center gap-(--space-8) font-mono text-size-xs">
          <span className="min-w-0 flex-1 truncate text-text-primary">{name}</span>
          <span className="text-text-secondary">{current}</span>
          <button
            type="button"
            aria-label={`Remove ${name}`}
            disabled={off}
            onClick={() => save(rows.filter(([other]) => other !== name))}
            className={CHIP_BUTTON}
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex items-center gap-(--space-6)">
        <input
          type="text"
          value={key}
          disabled={off}
          spellCheck={false}
          aria-label={`Key to add to ${entry.label}`}
          placeholder="key"
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // A key with no value yet moves on to the value; a complete pair is added.
            if (value.trim() === "") valueField.current?.focus();
            else add();
          }}
          className="h-(--size-control) min-w-0 flex-1 rounded-sm border border-border-field bg-bg-base px-(--space-8) font-mono text-size-xs text-text-primary placeholder:text-text-dim"
        />
        <input
          ref={valueField}
          type="text"
          value={value}
          disabled={off}
          spellCheck={false}
          aria-label={`Value to add to ${entry.label}`}
          placeholder="value"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
          }}
          className="h-(--size-control) min-w-0 flex-1 rounded-sm border border-border-field bg-bg-base px-(--space-8) font-mono text-size-xs text-text-primary placeholder:text-text-dim"
        />
        <button
          type="button"
          disabled={off || key.trim() === "" || value.trim() === ""}
          onClick={add}
          className="inline-flex items-center gap-(--space-4) text-size-sm text-text-secondary hover:text-text-primary disabled:opacity-(--opacity-disabled)"
        >
          <PlusIcon />
          Add
        </button>
      </div>
    </fieldset>
  );
}

function JsonControl({
  entry,
  disabled,
  invalid,
  labelId,
  describedBy,
  commit,
  reject,
  touch,
}: ControlProps) {
  const committed = jsonText(entry.value);
  const [draft, setDraft] = useDraft(committed);
  const [pending, run] = usePending();
  const save = () => {
    if (draft === committed) return;
    const parsed = parseJsonInput(draft);
    if (!parsed.ok) reject(parsed.message);
    else run(() => commit(parsed.value));
  };
  return (
    <textarea
      value={draft}
      rows={Math.min(12, Math.max(3, draft.split("\n").length))}
      disabled={disabled || pending}
      spellCheck={false}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      onChange={(event) => {
        touch();
        setDraft(event.target.value);
      }}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Escape") setDraft(committed);
      }}
      className={cx(FIELD, fieldBorder(invalid), "h-auto resize-y py-(--space-8) text-size-xs")}
    />
  );
}

const MASK = "••••••••••••";

/**
 * A secret is never in the listing. It shows as a mask; Reveal asks the sidecar for this one
 * value, and only then does the field hold it. Nothing is prefilled before that.
 */
function SecretControl({
  entry,
  disabled,
  invalid,
  labelId,
  describedBy,
  commit,
  clear,
  reveal,
  reject,
  touch,
}: ControlProps) {
  const stored = entry.layers.global.set || entry.layers.project.set;
  const [shown, setShown] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, run] = usePending();
  const editing = shown !== null || !stored;
  const save = () => {
    const base = shown ?? "";
    if (draft === base) return;
    run(() => (draft === "" ? clear() : commit(draft)));
  };
  return (
    <div className="relative w-full">
      <input
        type={editing && shown === null ? "password" : "text"}
        value={editing ? draft : MASK}
        readOnly={!editing}
        disabled={disabled || pending}
        spellCheck={false}
        autoComplete="off"
        placeholder={stored ? undefined : "Not set"}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        onChange={(event) => {
          touch();
          setDraft(event.target.value);
        }}
        onBlur={editing ? save : undefined}
        onKeyDown={(event) => {
          if (event.key === "Enter" && editing) save();
        }}
        className={cx(FIELD, fieldBorder(invalid), stored && "pr-(--space-64)")}
      />
      {stored && (
        <button
          type="button"
          aria-label={`${shown !== null ? "Hide" : "Reveal"} ${entry.label}`}
          onClick={() => {
            if (shown !== null) {
              setShown(null);
              setDraft("");
              return;
            }
            void reveal().then((result) => {
              if (result.ok) {
                setShown(result.value);
                setDraft(result.value);
              } else {
                reject(result.message);
              }
            });
          }}
          className="absolute top-1/2 right-(--space-10) -translate-y-1/2 text-size-xs text-text-secondary hover:text-text-primary"
        >
          {shown !== null ? "Hide" : "Reveal"}
        </button>
      )}
    </div>
  );
}

/** The one control a registry type calls for. */
export function Control(props: ControlProps) {
  const { entry } = props;
  if (entry.secret) return <SecretControl {...props} />;
  switch (entry.type) {
    case "boolean":
      return <BooleanControl {...props} />;
    case "enum":
      return entry.options ? <ChoiceControl {...props} /> : <TextControl {...props} />;
    case "number":
      return entry.options ? <ChoiceControl {...props} /> : <NumberControl {...props} />;
    case "string":
      return entry.options ? <ChoiceControl {...props} /> : <TextControl {...props} />;
    case "array":
      return entry.json ? <JsonControl {...props} /> : <ChipsControl {...props} />;
    case "record":
      return entry.json ? <JsonControl {...props} /> : <KeyValueControl {...props} />;
  }
}
