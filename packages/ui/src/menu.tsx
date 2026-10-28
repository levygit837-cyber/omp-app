import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { scrollClosesCard } from "./confirm-scroll";
import { cx } from "./cx";

/**
 * Where a menu opens, in viewport coordinates. The menu's top left corner goes at (`x`, `y`);
 * when it would run past the bottom edge it opens upward instead, ending at `above`.
 */
export interface MenuAnchor {
  x: number;
  y: number;
  above: number;
}

export interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  anchor: MenuAnchor;
  /**
   * The element the menu hangs from. A scroll closes the menu only when it can move this element.
   * Without it any scroll closes.
   */
  opener?: HTMLElement | null;
  /** Called on Esc, Tab, a press outside, a scroll or a resize. The owner unmounts the menu. */
  onDismiss: () => void;
  children: ReactNode;
}

const ITEMS = '[role="menuitem"]:not(:disabled)';

/**
 * A popup list of actions (Pen `QTqk0`). It takes focus when it opens and leaves it to the owner
 * when it closes, so the owner puts it back on the control that opened the menu. Esc closes the
 * menu and stops there: it must not also reach a window-level Esc that cancels a running turn.
 */
export function Menu({ label, anchor, opener, onDismiss, children }: MenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  // Measured before paint: the width and height only exist once the items are rendered.
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

  // A hidden element cannot take focus, so wait for the placement.
  const placed = place !== null;
  useEffect(() => {
    if (placed) root.current?.querySelector<HTMLElement>(ITEMS)?.focus();
  }, [placed]);

  const openerRef = useRef(opener);
  openerRef.current = opener;
  useEffect(() => {
    const close = () => dismiss.current();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    // The menu is fixed to the viewport, so anything that moves its row leaves it behind. A
    // scroll inside the menu (a long list keeping the focused item in view) moves nothing.
    const scrolled = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && root.current?.contains(target)) return;
      // A timeline streaming elsewhere scrolls all the time without moving the menu's row.
      if (scrollClosesCard(target, openerRef.current)) close();
    };
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
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const last = items.length - 1;
    switch (event.key) {
      case "Escape":
        event.stopPropagation();
        event.preventDefault();
        onDismiss();
        return;
      case "Tab":
        event.preventDefault();
        onDismiss();
        return;
      case "ArrowDown":
        items[at >= last ? 0 : at + 1]?.focus();
        break;
      case "ArrowUp":
        items[at <= 0 ? last : at - 1]?.focus();
        break;
      case "Home":
        items[0]?.focus();
        break;
      case "End":
        items[last]?.focus();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={root}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        visibility: place ? "visible" : "hidden",
      }}
      className="fixed z-50 flex w-(--layout-menu) flex-col rounded-md border border-border-default bg-bg-elevated p-(--space-4) shadow-menu"
    >
      {children}
    </div>
  );
}

export interface MenuItemProps extends ComponentProps<"button"> {
  /** A loss that cannot be undone (Clear context, Delete session): the label takes the error color. */
  danger?: boolean;
}

/**
 * One action of a `Menu`. Arrow keys move between items, so none of them is a tab stop. An item
 * that cannot run right now but has something to say uses `aria-disabled` (not `disabled`), so it
 * stays reachable and its `aria-describedby` note is read; its click does nothing.
 */
export function MenuItem({
  className,
  type = "button",
  danger = false,
  onClick,
  ...props
}: MenuItemProps) {
  const blocked = props["aria-disabled"] === true || props["aria-disabled"] === "true";
  return (
    <button
      type={type}
      role="menuitem"
      tabIndex={-1}
      onClick={blocked ? undefined : onClick}
      className={cx(
        "flex h-(--size-control) w-full items-center gap-(--space-8) rounded-sm px-(--space-8) text-left text-size-sm hover:bg-bg-hover focus-visible:bg-bg-hover",
        danger ? "text-state-error" : "text-text-primary",
        "disabled:text-text-dim disabled:hover:bg-transparent",
        "aria-disabled:text-text-dim aria-disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

/** A hairline between two groups of items (Pen `QTqk0`). */
export function MenuSeparator() {
  return <hr className="mx-(--space-4) my-(--space-4) border-0 border-t border-border-hairline" />;
}

/** The reason an item is blocked, in words, for its `aria-describedby`. Not an item itself. */
export function MenuNote({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      role="presentation"
      className={cx("px-(--space-8) py-(--space-4) text-size-xs text-text-dim", className)}
      {...props}
    />
  );
}
