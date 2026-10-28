import { useCallback, useEffect, useRef, useState } from "react";
import { COMPOSER_ID } from "../requests-view";
import { isPaletteShortcut } from "./shortcut";

const MAC = /Mac/.test(navigator.platform);

/**
 * Whether the palette is open, and where the focus goes when it closes. ⌘K arrives twice on
 * purpose: from the application menu (the accelerator that shows in View) and from the page, for
 * when the menu does not take it. Opening twice is the same as opening once.
 */
export function usePalette() {
  const [open, setOpen] = useState(false);
  const isOpen = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const restore = useRef(false);

  const show = useCallback(() => {
    if (isOpen.current) return;
    isOpen.current = true;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);

  /** `restoreFocus`: false when what the choice opened has taken the focus itself. */
  const hide = useCallback((restoreFocus = true) => {
    if (!isOpen.current) return;
    isOpen.current = false;
    restore.current = restoreFocus;
    setOpen(false);
  }, []);

  useEffect(() => window.omp.palette.onOpenRequested(show), [show]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event, MAC)) return;
      // A key from a view that cannot be used right now is not the person's.
      if (event.target instanceof Element && event.target.closest("[inert]")) return;
      event.preventDefault();
      show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  // After the dialog is gone: back to the control that opened it, or the input bar when that
  // control went away with the choice (a session was switched, a sidebar closed).
  useEffect(() => {
    if (open || !restore.current) return;
    restore.current = false;
    const before = opener.current;
    opener.current = null;
    const target =
      before?.isConnected && !before.closest("[inert]")
        ? before
        : document.getElementById(COMPOSER_ID);
    target?.focus();
  }, [open]);

  return { open, show, hide, mac: MAC };
}
