# Evidence for PR #41 (command palette)

All screenshots use the fake sidecar, a temp HOME and fixture projects. Nothing here comes from a real session.

- `shots/8-confirm-destructive.png`: the destructive confirm for `/session delete` (red Run).
- `shots/9-destructive-focus-on-cancel.png` + `destructive-focus.json`: the same confirm after the delta review. Focus starts on Cancel; a second Enter backs out (`/session delete` and `/usage reset`: confirm closed, 0 command lines), while a non-destructive confirm (`/export`) still starts on Run.
- `live-commands.txt`: `bun run scripts/live.ts --only=commands` against the real omp 18.12.6 (cheap model, temp cwd, own session dir removed). It includes the bypass check: `/force read /session delete` ends `failed` with "/session delete needs a confirmation first. Nothing was run." and the session file is still on disk. The socket tests for the same bypass are in `packages/sidecar/test/session-commands.test.ts` ("a gated line handed back by /force is not run", "the composer cannot run a gated builtin through session.prompt", "the host refuses a gated builtin on the prompt path").
