/**
 * `files.*` for the fake sidecar: a small invented project, so the Files page can be driven (and
 * photographed) without a live omp or a repository. Nothing here touches the disk.
 *
 * FAKE_FILES picks the state: `default` (a repository with changes), `clean` (a repository with no
 * change), `empty` (a repository with an empty folder), `norepo` (a folder that is not a
 * repository), `missing` (the folder is gone), `truncated` (more changes and entries than the
 * sidecar lists), `error` (every call fails), `timeout` (git did not answer). FAKE_FILES_MS delays
 * every answer (the loading state).
 */

import {
  type ChangeStatus,
  errorResponse,
  type FileChange,
  type FilesDiffResult,
  type FilesReadResult,
  type FilesStatusResult,
  type FilesTreeResult,
  MAX_FILE_BYTES,
  okResponse,
  type ResponseEnvelope,
  type TreeEntry,
} from "@omp-app/protocol";

const mode = process.env.FAKE_FILES ?? "default";
const DELAY_MS = Number(process.env.FAKE_FILES_MS ?? 0);

const CHANGES: FileChange[] = [
  { path: "src/session.ts", status: "M", added: 18, removed: 4 },
  { path: "src/files/tree.ts", status: "A", added: 42, removed: 0 },
  { path: "docs/legacy.md", status: "D", added: 0, removed: 12 },
  { path: "src/names.ts", from: "src/old-names.ts", status: "R", added: 2, removed: 1 },
  { path: "assets/logo.png", status: "M", added: null, removed: null, binary: true },
  { path: "notes/todo.txt", status: "?", added: 3, removed: 0 },
];

const MANY: FileChange[] = Array.from({ length: 5_000 }, (_, i) => ({
  path: `generated/file-${String(i).padStart(4, "0")}.ts`,
  status: "?" as ChangeStatus,
  added: 1,
  removed: 0,
}));

const TREE: Record<string, TreeEntry[]> = {
  "": [
    { name: "assets", kind: "dir" },
    { name: "docs", kind: "dir" },
    { name: "notes", kind: "dir" },
    { name: "src", kind: "dir" },
    { name: "README.md", kind: "file" },
    { name: "package.json", kind: "file" },
  ],
  assets: [
    { name: "logo.png", kind: "file" },
    { name: "huge.log", kind: "file" },
  ],
  docs: [{ name: "guide.md", kind: "file" }],
  notes: [{ name: "todo.txt", kind: "file" }],
  src: [
    { name: "files", kind: "dir" },
    { name: "names.ts", kind: "file" },
    { name: "session.ts", kind: "file" },
  ],
  "src/files": [{ name: "tree.ts", kind: "file" }],
};

const SESSION_TS = `import { readFileSync } from "node:fs";

export interface Session {
  readonly id: string;
  readonly cwd: string;
}

export function load(path: string): Session {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return { id: String(raw.id), cwd: String(raw.cwd) };
}
`;

const TEXT: Record<string, string> = {
  "README.md": "# Sample project\n\nA small invented project for the Files page.\n",
  "package.json": '{\n  "name": "sample",\n  "version": "1.0.0"\n}\n',
  "src/session.ts": SESSION_TS,
  "src/names.ts": 'export const names = ["a", "b"];\n',
  "src/files/tree.ts": "export const depth = 3;\n",
  "docs/guide.md": "# Guide\n\nRead the source.\n",
  "notes/todo.txt": "one\ntwo\nthree\n",
};

function status(): FilesStatusResult {
  const branch = { name: "main", head: "a1b2c3d", upstream: "origin/main", ahead: 1, behind: 0 };
  if (mode === "clean" || mode === "empty") {
    return {
      state: "ok",
      branch,
      changes: [],
      totals: { added: 0, modified: 0, deleted: 0 },
      truncated: false,
    };
  }
  const changes = mode === "truncated" ? MANY : CHANGES;
  const count = (kinds: string) => changes.filter((c) => kinds.includes(c.status)).length;
  return {
    state: "ok",
    branch,
    changes,
    totals: { added: count("A?"), modified: count("MRCTU"), deleted: count("D") },
    truncated: mode === "truncated",
  };
}

function tree(path: string): FilesTreeResult {
  if (mode === "empty") return { state: "ok", entries: [], truncated: false };
  if (mode === "truncated" && path === "") {
    const entries: TreeEntry[] = Array.from({ length: 2_000 }, (_, i) => ({
      name: `file-${String(i).padStart(4, "0")}.ts`,
      kind: "file",
    }));
    return { state: "ok", entries, truncated: true };
  }
  const entries = TREE[path];
  return entries ? { state: "ok", entries, truncated: false } : { state: "missing" };
}

function read(path: string): FilesReadResult {
  if (path === "assets/logo.png") return { state: "binary", bytes: 2_048 };
  if (path === "assets/huge.log") {
    return { state: "too_large", bytes: MAX_FILE_BYTES * 4, limit: MAX_FILE_BYTES };
  }
  const content = TEXT[path];
  if (content === undefined) return { state: "refused", reason: "missing" };
  return { state: "ok", path, content, bytes: content.length };
}

function diff(path: string): FilesDiffResult {
  const change = CHANGES.find((c) => c.path === path);
  if (!change) return { state: "unchanged" };
  if (change.binary) return { state: "binary", status: change.status };
  if (path === "src/session.ts") {
    return {
      state: "ok",
      path,
      status: "M",
      added: 2,
      removed: 1,
      truncated: false,
      rows: [
        {
          kind: "context",
          oldLine: 7,
          newLine: 7,
          text: "export function load(path: string): Session {",
        },
        {
          kind: "remove",
          oldLine: 8,
          text: '  const raw = JSON.parse(readFileSync(path, "utf8"));',
        },
        { kind: "add", newLine: 8, text: '  const text = readFileSync(path, "utf8");' },
        { kind: "add", newLine: 9, text: "  const raw = JSON.parse(text);" },
        {
          kind: "context",
          oldLine: 9,
          newLine: 10,
          text: "  return { id: String(raw.id), cwd: String(raw.cwd) };",
        },
      ],
    };
  }
  const text = TEXT[path] ?? "";
  const lines = text.split("\n").filter((l, i, all) => i < all.length - 1 || l !== "");
  if (change.status === "D") {
    return {
      state: "ok",
      path,
      status: "D",
      added: 0,
      removed: change.removed ?? 0,
      truncated: false,
      rows: [{ kind: "remove", oldLine: 1, text: "# Legacy notes" }],
    };
  }
  return {
    state: "ok",
    path,
    ...(change.from === undefined ? {} : { from: change.from }),
    status: change.status,
    added: lines.length,
    removed: 0,
    truncated: false,
    rows: lines.map((line, index) => ({ kind: "add" as const, newLine: index + 1, text: line })),
  };
}

const text = (params: unknown, name: string): string => {
  const value = (params as Record<string, unknown> | null)?.[name];
  return typeof value === "string" ? value : "";
};

/** `files.*`; undefined for any other method. Answers after FAKE_FILES_MS when set. */
export function handleFiles(
  method: string,
  id: string,
  params: unknown,
): ResponseEnvelope | Promise<ResponseEnvelope> | undefined {
  if (!method.startsWith("files.")) return undefined;
  const answer = (): ResponseEnvelope => {
    if (mode === "error") {
      return errorResponse(id, {
        code: "internal",
        message: "files unavailable: fatal: boom /Users/someone/private",
      });
    }
    const path = text(params, "path");
    switch (method) {
      case "files.status":
        if (mode === "norepo")
          return okResponse(id, { state: "not_repo" } satisfies FilesStatusResult);
        if (mode === "missing")
          return okResponse(id, { state: "missing" } satisfies FilesStatusResult);
        if (mode === "timeout")
          return okResponse(id, { state: "timeout" } satisfies FilesStatusResult);
        return okResponse(id, status());
      case "files.tree":
        if (mode === "missing")
          return okResponse(id, { state: "missing" } satisfies FilesTreeResult);
        return okResponse(id, tree(path));
      case "files.read":
        return okResponse(id, read(path));
      case "files.diff":
        return okResponse(id, diff(path));
      default:
        return errorResponse(id, { code: "unknown_method", message: "unknown method" });
    }
  };
  return DELAY_MS > 0 ? Bun.sleep(DELAY_MS).then(answer) : answer();
}
