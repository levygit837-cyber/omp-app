import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./button";
import { scrollClosesCard } from "./confirm-scroll";
import type { MenuAnchor } from "./menu";

export interface ConfirmCardProps {
  /** What is being asked, e.g. `Stop “explore”?`. Also the accessible name. */
  question: string;
  /** One sentence about what happens, said plainly (Pen `Km69K`). */
  consequence: string;
  confirmLabel: string;
  anchor: MenuAnchor;
  /**
   * The element the card hangs from. A scroll closes the card only when it can move this element;
   * a timeline streaming elsewhere on the page scrolls without moving it. Without it any scroll closes.
   */
  opener?: HTMLElement | null;
  onConfirm: () => void;
  /** Esc, Cancel, a press outside, a scroll or a resize. The owner unmounts the card and returns focus. */
  onCancel: () => void;
  /**
   * Which button takes the focus. A loss that cannot be undone starts on `cancel`, so a double
   * tap of Enter backs out; ⌘↵ then confirms from anywhere in the card (Pen `Km69K`).
   */
  focus?: "confirm" | "cancel";
}

/**
 * The confirmation of a destructive action (Pen `Km69K`): a small card in place of a dialog,
 * no scrim. It takes focus on the confirming button so Enter confirms; Esc cancels and stops
 * there, so it never also reaches a window-level Esc that cancels a running turn.
 */
export function ConfirmCard({
  question,
  consequence,
  confirmLabel,
  anchor,
  opener,
  focus = "confirm",
  onConfirm,
  onCancel,
}: ConfirmCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const safe = focus === "cancel";
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const left = Math.max(0, Math.min(anchor.x, window.innerWidth - el.offsetWidth));
    const top =
      anchor.y + el.offsetHeight > window.innerHeight
        ? Math.max(0, anchor.above - el.offsetHeight)
        : anchor.y;
    setPlace({ left, top });
  }, [anchor]);

  const placed = place !== null;
  useEffect(() => {
    if (placed) (safe ? cancelButton : confirm).current?.focus();
  }, [placed, safe]);

  const openerRef = useRef(opener);
  openerRef.current = opener;
  useEffect(() => {
    const close = () => cancel.current();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const scrolled = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (scrollClosesCard(target, openerRef.current)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      onCancel();
      return;
    }
    // The way to confirm when the focus starts on Cancel: Enter there backs out.
    if (safe && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.stopPropagation();
      event.preventDefault();
      onConfirm();
      return;
    }
    if (event.key !== "Tab") return;
    // Two controls, one loop: Tab never leaves the card for the page underneath.
    const buttons = Array.from(root.current?.querySelectorAll<HTMLElement>("button") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? at - 1 : at + 1;
    buttons.at(next % buttons.length)?.focus();
    event.preventDefault();
  };

  return (
    <div
      ref={root}
      role="alertdialog"
      aria-label={question}
      aria-describedby="confirm-card-consequence"
      onKeyDown={onKeyDown}
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        visibility: place ? "visible" : "hidden",
      }}
      className="fixed z-50 flex w-(--layout-confirm) flex-col gap-(--space-8) rounded-md border border-border-default bg-bg-elevated px-(--space-14) py-(--space-12) shadow-menu"
    >
      <p className="text-size-md text-text-primary">{question}</p>
      <p id="confirm-card-consequence" className="text-size-sm text-text-secondary">
        {consequence}
      </p>
      <div className="flex gap-(--space-8) pt-(--space-4)">
        <Button ref={confirm} variant="destructive" onClick={onConfirm}>
          {confirmLabel}
          <span aria-hidden="true" className="text-size-2xs">
            {safe ? "⌘↵" : "⏎"}
          </span>
        </Button>
        <Button ref={cancelButton} onClick={onCancel}>
          Cancel
          <span aria-hidden="true" className="text-size-2xs text-text-dim">
            esc
          </span>
        </Button>
      </div>
    </div>
  );
}
