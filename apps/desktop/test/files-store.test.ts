import { describe, expect, test } from "bun:test";
import {
  FILES_SUPERSEDED_MESSAGE,
  FILES_UNAVAILABLE_MESSAGE,
  type FilesStatusResult,
  type FilesTreeResult,
} from "@omp-app/protocol";
import { createFilesStore, type FilesApi } from "../src/renderer/files/files-store";

interface Call<T> {
  readonly args: readonly string[];
  resolve(value: T): void;
  reject(error: Error): void;
}

/** An api whose answers the test releases by hand, in any order. */
function manualApi() {
  const statuses: Call<FilesStatusResult>[] = [];
  const trees: Call<FilesTreeResult>[] = [];
  const api: FilesApi = {
    status: (...args) => new Promise((resolve, reject) => statuses.push({ args, resolve, reject })),
    tree: (...args) => new Promise((resolve, reject) => trees.push({ args, resolve, reject })),
  };
  return { api, statuses, trees };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const clean = (name: string): FilesStatusResult => ({
  state: "ok",
  branch: { name, head: "abc", upstream: null, ahead: 0, behind: 0 },
  changes: [],
  totals: { added: 0, modified: 0, deleted: 0 },
  truncated: false,
});
const listing = (...names: string[]): FilesTreeResult => ({
  state: "ok",
  entries: names.map((name) => ({ name, kind: "file" as const })),
  truncated: false,
});

describe("files store", () => {
  test("an older status answer that arrives late does not overwrite a newer one", async () => {
    const { api, statuses } = manualApi();
    const files = createFilesStore(api);
    files.refresh("s");
    files.refresh("s");
    statuses[1]?.resolve(clean("new"));
    await settle();
    statuses[0]?.resolve(clean("old"));
    await settle();
    const page = files.store.getState().pages.s;
    expect(page?.status).toMatchObject({ phase: "ready", result: { branch: { name: "new" } } });
    expect(page?.refreshed).toBe(1);
  });

  test("a superseded request is not shown as a failure", async () => {
    const { api, statuses } = manualApi();
    const files = createFilesStore(api);
    files.refresh("s");
    statuses[0]?.reject(new Error(`rpc: ${FILES_SUPERSEDED_MESSAGE}`));
    await settle();
    expect(files.store.getState().pages.s?.status.phase).toBe("loading");
  });

  test("a failure shows the sentence the window maps it to, never the sidecar's code", async () => {
    const { api, statuses } = manualApi();
    const files = createFilesStore(api);
    files.refresh("s");
    statuses[0]?.reject(
      new Error(`Error invoking remote method 'files:status': ${FILES_UNAVAILABLE_MESSAGE}`),
    );
    await settle();
    const status = files.store.getState().pages.s?.status;
    expect(status).toEqual({
      phase: "failed",
      message: "omp couldn’t read this project’s files. Try again in a moment.",
    });
  });

  test("folders are read only while the page is visible, root first, then the open ones", async () => {
    const { api, trees } = manualApi();
    const files = createFilesStore(api);
    files.refresh("s");
    expect(trees).toHaveLength(0);
    files.toggle("s", "src", true);
    files.setVisible("s", true);
    expect([...new Set(trees.map((t) => t.args[1]))].sort()).toEqual(["", "src"]);
    // `src` was asked for twice (opened, then shown): only the latest answer counts.
    const asked = trees.filter((t) => t.args[1] === "src");
    asked.at(-1)?.resolve(listing("new.ts"));
    await settle();
    asked[0]?.resolve(listing("old.ts"));
    await settle();
    expect(files.store.getState().pages.s?.dirs.src).toMatchObject({
      state: "ready",
      entries: [{ name: "new.ts" }],
    });
  });

  test("reveal opens every folder above a file and reads each", () => {
    const { api, trees } = manualApi();
    const files = createFilesStore(api);
    files.reveal("s", "a/b");
    expect(files.store.getState().pages.s?.expanded).toEqual(["a", "a/b"]);
    expect(trees.map((t) => t.args[1])).toEqual(["a", "a/b"]);
  });

  test("session.moved: the page follows the new id and answers addressed to the old one are dropped", async () => {
    const { api, statuses } = manualApi();
    const files = createFilesStore(api);
    files.refresh("old");
    files.moved("old", "new");
    statuses[0]?.resolve(clean("late"));
    await settle();
    const { pages } = files.store.getState();
    expect(pages.old).toBeUndefined();
    expect(pages.new?.status.phase).toBe("loading");
  });

  test("dispose forgets the page, ignores answers in flight and leaving does not bring it back", async () => {
    const { api, statuses } = manualApi();
    const files = createFilesStore(api);
    files.refresh("s");
    files.dispose("s");
    statuses[0]?.resolve(clean("late"));
    await settle();
    files.setVisible("s", false);
    expect(files.store.getState().pages).toEqual({});
  });

  test("an unreachable folder is shown as a failed node, per folder", async () => {
    const { api, trees } = manualApi();
    const files = createFilesStore(api);
    files.toggle("s", "gone", true);
    trees[0]?.resolve({ state: "missing" });
    await settle();
    expect(files.store.getState().pages.s?.dirs.gone?.state).toBe("failed");
  });
});
