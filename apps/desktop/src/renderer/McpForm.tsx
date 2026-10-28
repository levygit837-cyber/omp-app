import type { McpField, McpTransport } from "@omp-app/protocol";
import { Button, cx, PlusIcon } from "@omp-app/ui";
import { useEffect, useId, useRef, useState } from "react";
import { useDialogFocus } from "./dialog-focus";
import {
  draftChanged,
  duplicateKey,
  EMPTY_DRAFT,
  type SecretRow,
  type ServerDraft,
} from "./extensions-model";
import type { Outcome } from "./extensions-state";

const FIELD =
  "h-(--size-field) w-full rounded-sm border bg-bg-base px-(--space-10) font-mono text-size-sm text-text-primary placeholder:text-text-dim disabled:opacity-(--opacity-disabled)";

const border = (invalid: boolean) => (invalid ? "border-state-error" : "border-border-field");

const TRANSPORTS: ReadonlyArray<readonly [McpTransport, string]> = [
  ["stdio", "stdio"],
  ["http", "http"],
  ["sse", "sse"],
];

/** A labelled field with its inline error; the error is announced and tied to the control. */
function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: (describedBy: string | undefined, invalid: boolean) => React.ReactNode;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-(--space-6)">
      <label htmlFor={id} className="text-size-sm text-text-secondary">
        {label}
      </label>
      {children(describedBy || undefined, error !== undefined)}
      {hint && (
        <p id={hintId} className="text-size-xs text-text-dim">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-size-sm text-state-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Rows of environment variables or headers. A stored value is kept unless it is replaced. */
function SecretRows({
  idBase,
  label,
  addLabel,
  keyLabel,
  rows,
  error,
  disabled,
  onChange,
}: {
  idBase: string;
  label: string;
  addLabel: string;
  keyLabel: string;
  rows: readonly SecretRow[];
  error: string | undefined;
  disabled: boolean;
  onChange: (rows: readonly SecretRow[]) => void;
}) {
  const errorId = `${idBase}-error`;
  const set = (index: number, row: SecretRow) =>
    onChange(rows.map((r, i) => (i === index ? row : r)));
  return (
    <fieldset
      className="flex flex-col gap-(--space-8)"
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="pb-(--space-6) text-size-sm text-text-secondary">{label}</legend>
      {rows.map((row, index) => {
        return (
          // Rows have no identity of their own and are only added or removed by index.
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <div key={index} className="flex items-center gap-(--space-8)">
            <input
              aria-label={`${keyLabel} ${index + 1}`}
              value={row.key}
              readOnly={row.stored}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              placeholder={keyLabel}
              aria-invalid={error !== undefined || undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => set(index, { ...row, key: event.target.value })}
              className={cx(FIELD, border(error !== undefined), "w-(--size-field-narrow) flex-1")}
            />
            {row.stored ? (
              <>
                <span className="flex-1 font-mono text-size-sm text-text-dim">
                  ••••••••<span className="sr-only"> stored value kept</span>
                </span>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Replace the stored value of ${row.key}`}
                  onClick={() => set(index, { ...row, stored: false, value: "" })}
                >
                  Replace
                </Button>
              </>
            ) : (
              <input
                aria-label={`Value ${index + 1}`}
                type="password"
                value={row.value}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                placeholder="Value"
                aria-invalid={error !== undefined || undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => set(index, { ...row, value: event.target.value })}
                className={cx(FIELD, border(error !== undefined), "flex-1")}
              />
            )}
            <Button
              variant="ghost"
              disabled={disabled}
              aria-label={`Remove ${row.key.trim() === "" ? `row ${index + 1}` : row.key}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => onChange([...rows, { key: "", value: "", stored: false }])}
        >
          <PlusIcon />
          {addLabel}
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-size-sm text-state-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Asked when Esc would drop what the person typed. Keeping the form is the default answer. */
function DiscardPrompt({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box, onKeep);
  return (
    <div
      ref={box}
      role="alertdialog"
      aria-labelledby="mcp-discard-title"
      data-testid="mcp-discard-confirm"
      data-escape-owner=""
      className="flex flex-col gap-(--space-8) border-y border-state-approval-rule py-(--space-12)"
    >
      <p id="mcp-discard-title" className="text-size-md text-text-primary">
        Discard what you typed?
      </p>
      <div className="flex items-center gap-(--space-8)">
        <Button data-autofocus="" onClick={onKeep}>
          Keep editing
        </Button>
        <Button onClick={onDiscard}>Discard</Button>
      </div>
    </div>
  );
}

/**
 * The add and edit form of one server. omp's own refusal comes back as a sentence and lands
 * under the field it is about (`Outcome.field`); the form keeps what was typed.
 */
export function McpForm({
  mode,
  initial,
  locked,
  onSubmit,
  onCancel,
}: {
  mode: "add" | "edit";
  initial: ServerDraft | null;
  locked: boolean;
  onSubmit: (draft: ServerDraft) => Promise<Outcome>;
  onCancel: () => void;
}) {
  const base = useId();
  const [draft, setDraft] = useState<ServerDraft>(initial ?? EMPTY_DRAFT);
  const [errors, setErrors] = useState<Partial<Record<McpField | "form", string>>>({});
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const start = useRef(initial ?? EMPTY_DRAFT);
  const dirty = draftChanged(start.current, draft);
  const edit = (patch: Partial<ServerDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
  };

  useEffect(() => first.current?.focus(), []);

  // Esc closes the form from anywhere on the screen, but never drops typed text unasked. The
  // screen's own Esc handler stands down while an element marked `data-escape-owner` is mounted.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest("[inert]")) return;
      event.preventDefault();
      if (!dirty) onCancel();
      else setDiscarding(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, onCancel]);

  const submit = async () => {
    const dupEnv = duplicateKey(draft.env);
    const dupHeader = duplicateKey(draft.headers);
    if (draft.transport === "stdio" && dupEnv !== null) {
      setErrors({ env: `“${dupEnv}” appears twice.` });
      return;
    }
    if (draft.transport !== "stdio" && dupHeader !== null) {
      setErrors({ headers: `“${dupHeader}” appears twice.` });
      return;
    }
    setSaving(true);
    const outcome = await onSubmit(draft);
    setSaving(false);
    if (outcome.refused !== null) setErrors({ [outcome.field ?? "form"]: outcome.refused });
  };

  const disabled = locked || saving;
  const stdio = draft.transport === "stdio";
  const editing = mode === "edit";

  return (
    <form
      data-testid="mcp-form"
      data-escape-owner=""
      aria-label={editing ? `Edit ${draft.name}` : "Add MCP server"}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-(--space-16)"
    >
      <h2 className="text-size-title font-medium text-text-primary">
        {editing ? `Edit ${draft.name}` : "Add MCP server"}
      </h2>

      <Field id={`${base}-name`} label="Name" error={errors.name}>
        {(describedBy, invalid) => (
          <input
            id={`${base}-name`}
            ref={editing ? undefined : first}
            value={draft.name}
            readOnly={editing}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => edit({ name: event.target.value })}
            className={cx(FIELD, border(invalid))}
          />
        )}
      </Field>

      <fieldset className="flex items-center gap-(--space-2) self-start rounded-md border border-border-hairline p-(--space-2)">
        <legend className="sr-only">Transport</legend>
        {TRANSPORTS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={draft.transport === id}
            disabled={disabled}
            onClick={() => edit({ transport: id })}
            className={cx(
              "rounded-sm px-(--space-12) py-(--space-6) font-mono text-size-sm disabled:opacity-(--opacity-disabled)",
              draft.transport === id
                ? "bg-bg-selected text-text-primary"
                : "text-text-secondary hover:text-text-primary",
            )}
          >
            {label}
          </button>
        ))}
      </fieldset>

      {stdio ? (
        <>
          <Field id={`${base}-command`} label="Command" error={errors.command}>
            {(describedBy, invalid) => (
              <input
                id={`${base}-command`}
                ref={editing ? first : undefined}
                value={draft.command}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                placeholder="npx"
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onChange={(event) => edit({ command: event.target.value })}
                className={cx(FIELD, border(invalid))}
              />
            )}
          </Field>
          <Field
            id={`${base}-args`}
            label="Arguments"
            error={undefined}
            hint="Separated by spaces. Quote one that contains spaces. Arguments are shown and stored as typed: keep secrets in environment variables."
          >
            {(describedBy) => (
              <input
                id={`${base}-args`}
                value={draft.args}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                placeholder="-y @modelcontextprotocol/server-everything"
                aria-describedby={describedBy}
                onChange={(event) => edit({ args: event.target.value })}
                className={FIELD}
              />
            )}
          </Field>
          <SecretRows
            idBase={`${base}-env`}
            label="Environment variables"
            addLabel="Add variable"
            keyLabel="Name"
            rows={draft.env}
            error={errors.env}
            disabled={disabled}
            onChange={(env) => edit({ env })}
          />
        </>
      ) : (
        <>
          <Field
            id={`${base}-url`}
            label="URL"
            error={errors.url}
            hint={
              editing
                ? "Leave empty to keep the stored URL. Query values are hidden in the list; a key in the path is not, so keep keys in headers."
                : "Without http:// or https://, https:// is added. Keep keys in headers, not in the path."
            }
          >
            {(describedBy, invalid) => (
              <input
                id={`${base}-url`}
                ref={editing ? first : undefined}
                value={draft.url}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                placeholder="https://mcp.example.com/mcp"
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
                onChange={(event) => edit({ url: event.target.value })}
                className={cx(FIELD, border(invalid))}
              />
            )}
          </Field>
          <SecretRows
            idBase={`${base}-headers`}
            label="Headers"
            addLabel="Add header"
            keyLabel="Header"
            rows={draft.headers}
            error={errors.headers}
            disabled={disabled}
            onChange={(headers) => edit({ headers })}
          />
        </>
      )}

      {errors.form && (
        <p role="alert" data-testid="mcp-form-error" className="text-size-sm text-state-error">
          {errors.form}
        </p>
      )}

      {discarding && (
        <DiscardPrompt
          onKeep={() => setDiscarding(false)}
          onDiscard={() => {
            setDiscarding(false);
            onCancel();
          }}
        />
      )}

      <div className="flex items-center gap-(--space-8)">
        <Button type="submit" variant="primary" disabled={disabled}>
          {editing ? "Save" : "Add server"}
        </Button>
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
