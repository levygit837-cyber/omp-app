import type { ModelOption } from "@omp-app/protocol";
import { ChevronDownIcon, cx, Menu, type MenuAnchor, MenuItem } from "@omp-app/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { modelLabel } from "./format";
import { groupByProvider, thinkingChoices } from "./prompt-input";
import { message } from "./session-controller";
import { useModel, useThinking } from "./session-hooks";

/**
 * Why the pickers and the plan toggle are locked while a turn runs. omp applies the choice to the
 * next turn.
 */
export const LOCKED_WHILE_RUNNING = "Model, thinking and plan mode change when the turn ends.";
/** Id of the visible text that gives the reason; the locked triggers point `aria-describedby` at it. */
export const LOCKED_ID = "controls-locked-reason";

const TRIGGER =
  "inline-flex h-(--size-control) shrink-0 items-center gap-(--space-6) whitespace-nowrap rounded-sm px-(--space-4) text-size-sm text-text-dim hover:bg-bg-hover aria-disabled:opacity-(--opacity-disabled) aria-disabled:hover:bg-transparent";

/**
 * The models this session can switch to, read from omp when the bar mounts and again each time
 * a picker opens (credentials can change while the app runs). Null until the first answer.
 */
function useModelOptions(sessionId: string, onError: (text: string) => void) {
  const [models, setModels] = useState<readonly ModelOption[] | null>(null);
  const latest = useRef(0);
  const refresh = useCallback(() => {
    const call = ++latest.current;
    window.omp.session
      .models(sessionId)
      .then((list) => {
        if (call === latest.current) setModels(list);
      })
      .catch((e: unknown) => {
        if (call === latest.current) onError(message(e));
      });
  }, [sessionId, onError]);
  useEffect(() => {
    setModels(null);
    refresh();
    return () => {
      latest.current++;
    };
  }, [refresh]);
  return { models, refresh };
}

function anchorOf(button: HTMLElement): MenuAnchor {
  const box = button.getBoundingClientRect();
  return { x: box.left, y: box.bottom, above: box.top };
}

/**
 * Model and thinking level of the session, in the input bar (Pen `WARdo`). Each is a button that
 * opens a menu; both are locked while a turn runs, because the choice applies to the next turn.
 * A control without real data is not drawn: no thinking control for a model that has none, and
 * with no credentials the bar says so instead of showing an empty picker.
 */
export function ModelControls({
  sessionId,
  streaming,
  locked,
  onError,
}: {
  sessionId: string;
  streaming: boolean;
  /** The engine is not ready or the app is read-only: nothing can be changed. */
  locked: boolean;
  onError: (text: string) => void;
}) {
  const current = useModel(sessionId);
  const thinking = useThinking(sessionId);
  const { models, refresh } = useModelOptions(sessionId, onError);
  const [open, setOpen] = useState<"model" | "thinking" | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const thinkingButton = useRef<HTMLButtonElement>(null);

  const active = models?.find((m) => m.id === current);
  const levels = thinkingChoices(active);
  // Locked triggers stay focusable (`aria-disabled`, not `disabled`) so a keyboard user lands on
  // them and hears why; the click does nothing.
  const disabled = streaming || locked;
  const describedBy = streaming ? LOCKED_ID : undefined;
  const label = modelLabel(current);

  const dismiss = () => {
    const returnTo = open === "thinking" ? thinkingButton : modelButton;
    setOpen(null);
    setAnchor(null);
    returnTo.current?.focus();
  };

  const choose = (action: Promise<void>) => {
    dismiss();
    action.catch((e: unknown) => onError(message(e)));
  };

  if (models !== null && models.length === 0) {
    return (
      <p className="text-size-sm text-text-dim">
        No models available. Sign in to a provider in omp, then reopen this session.
      </p>
    );
  }

  return (
    <>
      {label && (
        <button
          ref={modelButton}
          type="button"
          data-testid="model-picker"
          aria-haspopup="menu"
          aria-expanded={open === "model"}
          aria-label={`Model: ${label}`}
          aria-disabled={disabled || models === null || undefined}
          aria-describedby={describedBy}
          className={TRIGGER}
          onClick={(event) => {
            if (disabled || models === null) return;
            refresh();
            setAnchor(anchorOf(event.currentTarget));
            setOpen("model");
          }}
        >
          model <span className="font-mono text-size-xs text-text-primary">{label}</span>
          <ChevronDownIcon />
        </button>
      )}
      {levels.length > 0 && thinking && (
        <button
          ref={thinkingButton}
          type="button"
          data-testid="thinking-picker"
          aria-haspopup="menu"
          aria-expanded={open === "thinking"}
          aria-label={`Thinking: ${thinking}`}
          aria-disabled={disabled || undefined}
          aria-describedby={describedBy}
          className={TRIGGER}
          onClick={(event) => {
            if (disabled) return;
            setAnchor(anchorOf(event.currentTarget));
            setOpen("thinking");
          }}
        >
          thinking{" "}
          {/* Frame WARdo draws high levels in gold (#F3C24F). That is the approval color, and the bar
              can show an approval mark next to the level, so the level stays neutral on purpose. */}
          <span className="text-size-sm text-text-primary">{thinking}</span>
          <ChevronDownIcon />
        </button>
      )}
      {open === "model" && anchor && models && (
        <Menu label="Models" anchor={anchor} onDismiss={dismiss}>
          <div className="flex max-h-(--layout-menu-list-max) flex-col overflow-y-auto">
            {groupByProvider(models).map((group) => (
              <div key={group.provider} role="presentation" className="flex flex-col">
                <p
                  role="presentation"
                  className="px-(--space-8) pt-(--space-6) pb-(--space-2) font-mono text-size-2xs tracking-caps text-text-dim uppercase"
                >
                  {group.provider}
                </p>
                {group.models.map((model) => (
                  <ChoiceItem
                    key={model.id}
                    current={model.id === current}
                    onChoose={() => choose(window.omp.session.setModel(sessionId, model.id))}
                  >
                    {model.name}
                  </ChoiceItem>
                ))}
              </div>
            ))}
          </div>
        </Menu>
      )}
      {open === "thinking" && anchor && (
        <Menu label="Thinking level" anchor={anchor} onDismiss={dismiss}>
          {levels.map((level) => (
            <ChoiceItem
              key={level}
              current={level === thinking}
              onChoose={() => choose(window.omp.session.setThinking(sessionId, level))}
            >
              {level}
            </ChoiceItem>
          ))}
        </Menu>
      )}
    </>
  );
}

/** A menu entry that says whether it is the current choice in words, not by color. */
function ChoiceItem({
  current,
  onChoose,
  children,
}: {
  current: boolean;
  onChoose: () => void;
  children: string;
}) {
  return (
    <MenuItem aria-current={current ? "true" : undefined} onClick={onChoose}>
      <span className={cx("min-w-0 flex-1 truncate", current && "font-medium")}>{children}</span>
      {current && <span className="shrink-0 text-size-2xs text-text-dim">current</span>}
    </MenuItem>
  );
}
