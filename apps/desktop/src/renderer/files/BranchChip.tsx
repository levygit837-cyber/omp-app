import { BranchIcon } from "@omp-app/ui";
import { branchChip } from "./files-model";
import { usePage } from "./use-files";

/** The checked-out branch and how many files differ, in the input bar. Absent when not a repo. */
export function BranchChip({ sessionId }: { sessionId: string }) {
  const status = usePage(sessionId)?.status;
  if (status?.phase !== "ready" || status.result.state !== "ok") return null;
  const chip = branchChip(status.result.branch, status.result.totals);
  if (!chip) return null;
  return (
    <span
      data-testid="branch-chip"
      title={chip.label}
      className="flex items-center gap-(--space-4) font-mono text-size-xs whitespace-nowrap text-text-dim"
    >
      <BranchIcon className="text-icon-neutral" />
      <span aria-hidden="true">{chip.counts ? `${chip.name} ${chip.counts}` : chip.name}</span>
      <span className="sr-only">{chip.label}</span>
    </span>
  );
}
