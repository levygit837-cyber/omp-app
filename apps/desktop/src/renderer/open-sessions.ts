import { SessionLostError } from "./session-store";

/** The sessions the window keeps open, and which one the center column shows. */
export interface OpenSessions {
  readonly open: readonly string[];
  readonly focused: string | null;
}

export const NONE: OpenSessions = { open: [], focused: null };

/** Opens a session (if it is not yet) and focuses it. */
export function add(state: OpenSessions, id: string): OpenSessions {
  return { open: state.open.includes(id) ? state.open : [...state.open, id], focused: id };
}

/** Focuses a session that is open; any other id changes nothing. */
export function focus(state: OpenSessions, id: string): OpenSessions {
  return state.open.includes(id) ? { ...state, focused: id } : state;
}

/**
 * Removes a session from the open set. When it was the focused one, focus goes to the session
 * that took its place in the list, else to the one before it, else to nothing.
 */
export function remove(state: OpenSessions, id: string): OpenSessions {
  const at = state.open.indexOf(id);
  if (at === -1) return state;
  const open = state.open.filter((other) => other !== id);
  if (state.focused !== id) return { open, focused: state.focused };
  return { open, focused: open[at] ?? open[at - 1] ?? null };
}

/**
 * The session now lives under another id (omp moved it to a new file because another process
 * owns the old one). The open set and the focus follow; its place in the list is kept. An id
 * that is not open changes nothing, and a successor that is already open just replaces it.
 */
export function rekey(state: OpenSessions, from: string, to: string): OpenSessions {
  if (from === to || !state.open.includes(from)) return state;
  const open = state.open.map((id) => (id === from ? to : id));
  return {
    open: [...new Set(open)],
    focused: state.focused === from ? to : state.focused,
  };
}

export function serialize(state: OpenSessions): string {
  return JSON.stringify(state);
}

/** Reads what `serialize` wrote. Anything else (no value, bad JSON, wrong shape) is "none open". */
export function parse(raw: string | null): OpenSessions {
  if (!raw) return NONE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NONE;
  }
  if (typeof value !== "object" || value === null) return NONE;
  const { open, focused } = value as { open?: unknown; focused?: unknown };
  if (!Array.isArray(open)) return NONE;
  const ids = [...new Set(open.filter((id): id is string => typeof id === "string" && id !== ""))];
  return {
    open: ids,
    focused: typeof focused === "string" && ids.includes(focused) ? focused : null,
  };
}

export interface ReopenApi {
  /**
   * Attaches the window to a session the sidecar already holds; resolves with the id it is under
   * now (a session omp moved to a new file answers to a new id). Rejects with `SessionLostError`
   * if the sidecar does not hold it.
   */
  open(sessionId: string): Promise<string>;
  /** Loads a stored session into the sidecar again; resolves with its id. */
  resume(sessionId: string): Promise<string>;
}

export interface Reopened {
  readonly state: OpenSessions;
  /** The session that was focused could not be brought back. */
  readonly focusedLost: boolean;
}

/**
 * Brings a remembered set of sessions back after a reload or a sidecar restart. A session the
 * sidecar still holds is simply attached again (a turn in flight keeps streaming). One it forgot
 * is read from its file with its full history, since sessions live on disk; only a session that
 * cannot be resumed either is dropped.
 */
export async function reopen(api: ReopenApi, remembered: OpenSessions): Promise<Reopened> {
  const brought = await Promise.all(
    remembered.open.map(async (id): Promise<string | null> => {
      try {
        return await api.open(id);
      } catch (error) {
        if (!(error instanceof SessionLostError)) return null;
      }
      try {
        return await api.open(await api.resume(id));
      } catch {
        return null;
      }
    }),
  );
  const open = brought.filter((id): id is string => id !== null);
  const wanted = remembered.focused;
  const at = wanted === null ? -1 : remembered.open.indexOf(wanted);
  const focused = at === -1 ? null : (brought[at] ?? null);
  return {
    state: { open, focused: focused ?? open[0] ?? null },
    focusedLost: wanted !== null && focused === null,
  };
}
