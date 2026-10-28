import { MAIN_TAB, type TabRef, tabKey } from "./delegation-view";

/**
 * Which tab each session shows, and which tabs the person closed. A closed tab only leaves the
 * top bar: the subagent keeps its row in the sidebar, and picking it there brings the tab back.
 */
export interface TabState {
  readonly selected: Readonly<Record<string, TabRef>>;
  readonly dismissed: Readonly<Record<string, readonly string[]>>;
}

export const NO_TABS: TabState = { selected: {}, dismissed: {} };

/** Shows a tab, and brings it back if it had been closed. The chat is selected by clearing. */
export function selectTab(state: TabState, sessionId: string, ref: TabRef): TabState {
  const key = tabKey(ref);
  const dismissed = state.dismissed[sessionId] ?? [];
  return {
    selected: { ...state.selected, [sessionId]: ref },
    dismissed: dismissed.includes(key)
      ? { ...state.dismissed, [sessionId]: dismissed.filter((k) => k !== key) }
      : state.dismissed,
  };
}

/**
 * Closes a tab. The chat cannot be closed. Closing the tab on screen falls back to the chat,
 * which always exists, so there is never a blank panel.
 */
export function dismissTab(state: TabState, sessionId: string, ref: TabRef): TabState {
  if (ref.kind === "main") return state;
  const key = tabKey(ref);
  const dismissed = state.dismissed[sessionId] ?? [];
  if (dismissed.includes(key)) return state;
  const shown = state.selected[sessionId];
  const { [sessionId]: _gone, ...rest } = state.selected;
  return {
    selected: shown && tabKey(shown) === key ? rest : state.selected,
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
  return { selected: move(state.selected), dismissed: move(state.dismissed) };
}

export const selectedOf = (state: TabState, sessionId: string): TabRef =>
  state.selected[sessionId] ?? MAIN_TAB;
