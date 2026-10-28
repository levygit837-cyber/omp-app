import {
  FILES_SUPERSEDED_MESSAGE,
  type FilesStatusResult,
  type FilesTreeResult,
} from "@omp-app/protocol";
import type { StoreApi } from "zustand/vanilla";
import { createStore } from "zustand/vanilla";
import type { OmpBridge } from "../../shared/bridge";
import { describeError } from "../errors";
import { ancestorsOf, type DirNode } from "./files-model";

/** The sidecar's answer to the last status request of a session, or why there is none. */
export type StatusState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly result: FilesStatusResult }
  | { readonly phase: "failed"; readonly message: string };

/** Everything the window keeps about one session's Files page. */
export interface PageState {
  readonly status: StatusState;
  /** How many status answers have landed; a file view reads its file again when it grows. */
  readonly refreshed: number;
  /** Listing of each folder looked at, by path relative to the project ("" is the root). */
  readonly dirs: Readonly<Record<string, DirNode>>;
  /** Folders the person opened, in the order they did. */
  readonly expanded: readonly string[];
  /** The Files page is on screen, so the tree is worth keeping current. */
  readonly visible: boolean;
}

export interface FilesState {
  readonly pages: Readonly<Record<string, PageState>>;
}

export type FilesApi = Pick<OmpBridge["files"], "status" | "tree">;

export interface FilesStore {
  readonly store: StoreApi<FilesState>;
  /** Reads git state again, and the folders on screen when the page is visible. Never throws. */
  refresh(sessionId: string): void;
  setVisible(sessionId: string, visible: boolean): void;
  /** Opens or closes a folder; opening reads it. */
  toggle(sessionId: string, dir: string, open: boolean): void;
  /** Opens `dir` and every folder above it, so what is inside can be seen. The root is always open. */
  reveal(sessionId: string, dir: string): void;
  /** The session lives under another id from now on: its page follows, answers in flight are dropped. */
  moved(from: string, to: string): void;
  /** The session is gone: forget its page and drop answers in flight. */
  dispose(sessionId: string): void;
}

const LOADING: PageState = {
  status: { phase: "loading" },
  refreshed: 0,
  dirs: {},
  expanded: [],
  visible: false,
};

/** A folder listing as the node the tree draws. */
export function nodeOf(result: FilesTreeResult): DirNode {
  switch (result.state) {
    case "ok":
      return { state: "ready", entries: result.entries, truncated: result.truncated };
    case "missing":
      return { state: "failed", message: "This folder no longer exists." };
    case "refused":
      return { state: "failed", message: "This folder can’t be opened from here." };
    case "timeout":
      return { state: "failed", message: "Listing this folder took too long." };
    default:
      return result satisfies never;
  }
}

const isSuperseded = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(FILES_SUPERSEDED_MESSAGE);

/**
 * The Files page's state, one per session. Every request carries a counter: an answer that is no
 * longer the latest of its kind (a newer refresh started, the session moved or closed) is dropped
 * instead of overwriting newer data. Nothing here touches the window, so it runs under test.
 */
export function createFilesStore(api: FilesApi): FilesStore {
  const store = createStore<FilesState>(() => ({ pages: {} }));
  // Dynamic keys (a session id, or a session id and a folder), so a Map.
  const generation = new Map<string, number>();
  const dirKey = (sessionId: string, dir: string) => `${sessionId}\0${dir}`;

  // One counter for every key, never reset: a forgotten key that comes back (a closed session's id
  // reused) cannot hand out a number an old request in flight still holds.
  let issued = 0;
  const start = (key: string): number => {
    generation.set(key, ++issued);
    return issued;
  };
  const latest = (key: string, n: number): boolean => generation.get(key) === n;
  const forget = (sessionId: string) => {
    for (const key of [...generation.keys()]) {
      if (key === sessionId || key.startsWith(`${sessionId}\0`)) generation.delete(key);
    }
  };

  const patch = (sessionId: string, change: (page: PageState) => PageState) =>
    store.setState((state) => {
      const page = state.pages[sessionId];
      return page ? { pages: { ...state.pages, [sessionId]: change(page) } } : state;
    });
  const pageOf = (sessionId: string): PageState => {
    const page = store.getState().pages[sessionId];
    if (page) return page;
    store.setState((state) => ({ pages: { ...state.pages, [sessionId]: LOADING } }));
    return LOADING;
  };

  const loadDir = (sessionId: string, dir: string) => {
    const key = dirKey(sessionId, dir);
    const n = start(key);
    patch(sessionId, (page) =>
      page.dirs[dir] ? page : { ...page, dirs: { ...page.dirs, [dir]: { state: "loading" } } },
    );
    const set = (node: DirNode) =>
      patch(sessionId, (page) => ({ ...page, dirs: { ...page.dirs, [dir]: node } }));
    api.tree(sessionId, dir).then(
      (result) => {
        if (latest(key, n)) set(nodeOf(result));
      },
      (error: unknown) => {
        if (latest(key, n) && !isSuperseded(error)) {
          set({ state: "failed", message: describeError(error) });
        }
      },
    );
  };

  const loadVisible = (sessionId: string) => {
    const page = store.getState().pages[sessionId];
    if (!page?.visible) return;
    for (const dir of ["", ...page.expanded]) loadDir(sessionId, dir);
  };

  return {
    store,
    refresh(sessionId) {
      pageOf(sessionId);
      const n = start(sessionId);
      api.status(sessionId).then(
        (result) => {
          if (latest(sessionId, n))
            patch(sessionId, (p) => ({
              ...p,
              status: { phase: "ready", result },
              refreshed: p.refreshed + 1,
            }));
        },
        (error: unknown) => {
          if (!latest(sessionId, n) || isSuperseded(error)) return;
          patch(sessionId, (p) => ({
            ...p,
            status: { phase: "failed", message: describeError(error) },
          }));
        },
      );
      loadVisible(sessionId);
    },
    setVisible(sessionId, visible) {
      // Leaving a page that was disposed meanwhile must not bring it back.
      if (!visible && !store.getState().pages[sessionId]) return;
      pageOf(sessionId);
      patch(sessionId, (page) => (page.visible === visible ? page : { ...page, visible }));
      if (visible) loadVisible(sessionId);
    },
    toggle(sessionId, dir, open) {
      pageOf(sessionId);
      patch(sessionId, (page) => {
        const without = page.expanded.filter((d) => d !== dir);
        return { ...page, expanded: open ? [...without, dir] : without };
      });
      if (open) loadDir(sessionId, dir);
    },
    reveal(sessionId, dir) {
      if (dir === "") return;
      pageOf(sessionId);
      const folders = [...ancestorsOf(dir), dir];
      patch(sessionId, (page) => ({
        ...page,
        expanded: [...page.expanded.filter((d) => !folders.includes(d)), ...folders],
      }));
      for (const dir of folders) loadDir(sessionId, dir);
    },
    moved(from, to) {
      forget(from);
      store.setState((state) => {
        const { [from]: page, ...rest } = state.pages;
        return page && from !== to ? { pages: { ...rest, [to]: page } } : state;
      });
    },
    dispose(sessionId) {
      forget(sessionId);
      store.setState((state) => {
        const { [sessionId]: _gone, ...rest } = state.pages;
        return sessionId in state.pages ? { pages: rest } : state;
      });
    },
  };
}
