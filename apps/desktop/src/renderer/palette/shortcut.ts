export interface KeyLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** True while an input method is composing: the key belongs to it, not to the shortcut. */
  readonly isComposing?: boolean;
}

/**
 * ⌘K (Ctrl+K elsewhere). The application menu registers the same accelerator, so on most
 * platforms the menu fires first; this is the same key seen by the page, for when it is not.
 * Opening is idempotent, so both may fire. It opens from a text field too: ⌘K means nothing in
 * one. Ctrl+K on a Mac (kill-line in a text field) is left alone.
 */
export function isPaletteShortcut(event: KeyLike, mac: boolean): boolean {
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return (
    modifier &&
    !event.isComposing &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "k"
  );
}
