import { type RefObject, useEffect, useRef } from "react";

/**
 * The index Tab or Shift+Tab lands on inside a dialog of `count` controls: it wraps instead of
 * leaving the dialog. `current` is -1 when focus is not on one of them.
 */
export function wrapFocus(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? count - 1 : 1)) % count;
}

const FOCUSABLE =
  "button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Behaves like a modal dialog without covering the screen: focus moves in when it opens (to the
 * element marked `data-autofocus`, else the first control), Tab stays inside, Esc calls
 * `onEscape` and goes no further, and focus goes back to where it was when the dialog closes
 * (`returnTo`, else the element focused when it opened; skipped when the page already moved focus elsewhere, as a removed row does).
 */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  onEscape: () => void,
  returnTo?: RefObject<HTMLElement | null>,
): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    (dialog.querySelector<HTMLElement>("[data-autofocus]") ?? controls()[0])?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        latest.current();
        return;
      }
      if (event.key !== "Tab") return;
      const list = controls();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = list[wrapFocus(list.length, at, event.shiftKey)];
      if (next === undefined) return;
      event.preventDefault();
      next.focus();
    };
    dialog.addEventListener("keydown", onKey);
    return () => {
      dialog.removeEventListener("keydown", onKey);
      const back = returnTo?.current ?? opener;
      if (
        back?.isConnected &&
        (document.activeElement === document.body || dialog.contains(document.activeElement))
      ) {
        back.focus();
      }
    };
  }, [ref, returnTo]);
}
