import { useEffect, useRef, useState } from "react";

/** The pages of the right sidebar. One is selected at a time; the choice outlives a collapse. */
export type PanelPage = "general" | "files";

/**
 * Open/closed state of the right sidebar, with the same focus handoff as the left one: the toggle
 * that was pressed unmounts with its state, so focus moves to the one that replaces it.
 * Like the left sidebar it is not persisted.
 */
export function useRightPanel() {
  const [open, setOpen] = useState(true);
  const [page, setPage] = useState<PanelPage>("general");
  const hideButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const handoff = useRef(false);
  const toggle = (next: boolean) => {
    handoff.current = true;
    setOpen(next);
  };
  useEffect(() => {
    if (!handoff.current) return;
    handoff.current = false;
    (open ? hideButton : showButton).current?.focus();
  }, [open]);
  return { open, toggle, page, setPage, hideButton, showButton };
}
