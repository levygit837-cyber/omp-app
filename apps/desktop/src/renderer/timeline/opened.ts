import { useState } from "react";

/**
 * Which lines the user expanded. Rows unmount while scrolling (the list is virtualized), so a
 * `useState` alone would forget; this set outlives the row. Lost on reload, which is fine.
 */
const opened = new Set<string>();

export function useOpened(key: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => opened.has(key));
  const toggle = () => {
    setOpen((was) => {
      if (was) opened.delete(key);
      else opened.add(key);
      return !was;
    });
  };
  return [open, toggle];
}
