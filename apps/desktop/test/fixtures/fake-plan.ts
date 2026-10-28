import type { PlanReadResult, SessionOp, SessionViewModel } from "@omp-app/protocol";

/** What the fake sidecar needs of a session for the plan methods. */
export interface PlanFakeSession {
  readonly vm: SessionViewModel;
}

/** The plan the fake agent "wrote". The first lines match the approval message of `fake-requests`. */
export const FAKE_PLAN_FILE = "local://rename-config-loader-plan.md";
export const FAKE_PLAN_MARKDOWN = [
  "# Rename the config loader",
  "",
  "## Steps",
  "",
  "1. Read `src/config.ts`.",
  "2. Rename `load` to `loadConfig`.",
  "   - keep the old name exported until the callers move",
  "3. Update the callers in `src/cli` and `src/server`.",
  "4. Run the tests.",
  "",
  "## Files",
  "",
  "| File | Change |",
  "| --- | --- |",
  "| `src/config.ts` | rename the export |",
  "| `src/cli/main.ts` | use `loadConfig` |",
  "| `src/server/boot.ts` | use `loadConfig` |",
  "",
  "## Verification",
  "",
  "```sh",
  "bun test",
  "```",
  "",
].join("\n");

/** The plan file exists once a proposal was raised, and stays after a refine (omp never deletes it). */
const proposed = (vm: SessionViewModel): boolean =>
  vm.pending.some((r) => r.id === "fake-plan") ||
  vm.timeline.some((i) => i.kind === "decision" && i.subject.startsWith("Approve plan"));

/**
 * Plan mode of the fake sidecar. `FAKE_PLAN=refused:<reason>` makes the reader refuse, so the
 * view's answer to a refusal can be seen without a symlink on disk. `FAKE_PLAN=earlier` reads the
 * plan as one written before plan mode was turned on (a re-entry).
 */
export function handlePlan(
  method: string,
  session: PlanFakeSession,
  emit: (op: SessionOp) => void,
  params: unknown,
): { result: unknown } | undefined {
  if (method === "session.setPlanMode") {
    const enabled = (params as { enabled?: unknown } | null)?.enabled === true;
    emit({
      type: "plan.set",
      plan: { enabled, planFile: enabled ? "local://PLAN.md" : null },
    });
    return { result: null };
  }
  if (method === "session.readPlan") {
    const refusal = /^refused:(.+)$/.exec(process.env.FAKE_PLAN ?? "")?.[1];
    const result: PlanReadResult = refusal
      ? { state: "refused", reason: refusal as "too_large" }
      : session.vm.plan.enabled && proposed(session.vm)
        ? {
            state: "ok",
            file: FAKE_PLAN_FILE,
            content: FAKE_PLAN_MARKDOWN,
            earlier: process.env.FAKE_PLAN === "earlier",
          }
        : { state: "missing" };
    return { result };
  }
  return undefined;
}
