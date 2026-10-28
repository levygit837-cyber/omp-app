import { MAIN_TAB, type TabRef, tabKey } from "./delegation-view";

/** Most file tabs a session keeps open; opening one more closes the oldest that is not on screen. */
export const MAX_FILE_TABS = 16;

/**
 * Which tab each session shows, which tabs the person closed, and which files they opened. A
 * closed subagent or job tab only leaves the top bar: it keeps its row in the sidebar, and picking
 * it there brings the tab back. A file tab has no row anywhere else, so closing it forgets it.
 */
export interface TabState {
  readonly selected: Readonly<Record<string, TabRef>>;
  readonly dismissed: Readonly<Record<string, readonly string[]>>;
  /** Paths of the open file tabs of each session, oldest first. */
  readonly files: Readonly<Record<string, readonly string[]>>;
}

export const NO_TABS: TabState = { selected: {}, dismissed: {}, files: {} };

/** Adds a path to the open files, dropping the oldest other one past the cap. */
function withFile(open: readonly string[], path: string): readonly string[] {
  if (open.includes(path)) return open;
  const next = [...open, path];
  if (next.length <= MAX_FILE_TABS) return next;
  return next.slice(next.length - MAX_FILE_TABS);
}

/** Shows a tab, and brings it back if it had been closed. The chat is selected by clearing. */
export function selectTab(state: TabState, sessionId: string, ref: TabRef): TabState {
  const key = tabKey(ref);
  const dismissed = state.dismissed[sessionId] ?? [];
  const open = state.files[sessionId] ?? [];
  const files = ref.kind === "file" ? withFile(open, ref.path) : open;
  return {
    selected: { ...state.selected, [sessionId]: ref },
    dismissed: dismissed.includes(key)
      ? { ...state.dismissed, [sessionId]: dismissed.filter((k) => k !== key) }
      : state.dismissed,
    files: files === open ? state.files : { ...state.files, [sessionId]: files },
  };
}

/**
 * Closes a tab. The chat cannot be closed. Closing the tab on screen falls back to the chat,
 * which always exists, so there is never a blank panel.
 */
export function dismissTab(state: TabState, sessionId: string, ref: TabRef): TabState {
  if (ref.kind === "main") return state;
  const key = tabKey(ref);
  const shown = state.selected[sessionId];
  const { [sessionId]: _gone, ...rest } = state.selected;
  const selected = shown && tabKey(shown) === key ? rest : state.selected;
  if (ref.kind === "file") {
    const open = state.files[sessionId] ?? [];
    if (!open.includes(ref.path)) return state;
    return {
      ...state,
      selected,
      files: { ...state.files, [sessionId]: open.filter((path) => path !== ref.path) },
    };
  }
  const dismissed = state.dismissed[sessionId] ?? [];
  if (dismissed.includes(key)) return state;
  return {
    ...state,
    selected,
    dismissed: { ...state.dismissed, [sessionId]: [...dismissed, key] },
  };
}

/** The session lives under another id from now on (`session.moved`): its tabs follow it. */
export function rekeyTabs(state: TabState, from: string, to: string): TabState {
  if (from === to) return state;
  const move = <T>(record: Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
    if (!(from in record)) return record;
    const { [from]: value, ...rest } = record;
    return { ...rest, [to]: value as T };
  };
  return {
    selected: move(state.selected),
    dismissed: move(state.dismissed),
    files: move(state.files),
  };
}

export const selectedOf = (state: TabState, sessionId: string): TabRef =>
  state.selected[sessionId] ?? MAIN_TAB;
