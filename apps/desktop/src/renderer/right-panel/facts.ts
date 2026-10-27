import type { ContextFill, TodoPhase, TodoStatus } from "@omp-app/protocol";

/** 950 -> "950", 48_200 -> "48.2k", 200_000 -> "200k", 1_250_000 -> "1.3M". Negative and NaN read as 0. */
export function formatTokens(count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, count) : 0;
  if (n < 1000) return String(Math.round(n));
  // Rounded to one decimal, so String() prints "48.2" or "200" and never a trailing ".0".
  const thousands = Math.round(n / 100) / 10;
  if (thousands < 1000) return `${thousands}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}

/** Cents above one cent, three decimals below it. Null when nothing was spent: the line is not shown. */
export function formatCost(cost: number): string | null {
  if (!Number.isFinite(cost) || cost <= 0) return null;
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  const rounded = cost.toFixed(3);
  return rounded === "0.000" ? "<$0.001" : `$${rounded}`;
}

/** Share of `whole` that `part` covers, clamped to 0..100. A missing window reads as empty. */
export function percentOf(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

export interface ContextMeter {
  fillPercent: number;
  /** Where auto-compaction triggers, as a percent of the window; null when it is off or out of range. */
  compactPercent: number | null;
  used: string;
  window: string;
  compactAt: string | null;
}

export function contextMeter(context: ContextFill): ContextMeter {
  const { compactAtTokens } = context;
  const hasThreshold =
    compactAtTokens !== undefined && compactAtTokens > 0 && compactAtTokens <= context.window;
  return {
    fillPercent: percentOf(context.tokens, context.window),
    compactPercent: hasThreshold ? percentOf(compactAtTokens, context.window) : null,
    used: formatTokens(context.tokens),
    window: formatTokens(context.window),
    compactAt: hasThreshold ? formatTokens(compactAtTokens) : null,
  };
}

export interface TodoRow {
  content: string;
  status: TodoStatus;
}

export interface TodoGroup {
  /** The phase name; callers show it only when there is more than one group. */
  name: string;
  tasks: TodoRow[];
}

export interface TodoSummary {
  groups: TodoGroup[];
  done: number;
  total: number;
}

/** Phases without tasks drop out; `done` counts completed tasks only (abandoned ones are not done). */
export function summarizeTodo(phases: readonly TodoPhase[]): TodoSummary {
  const groups = phases
    .filter((phase) => phase.tasks.length > 0)
    .map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.map((task) => ({ content: task.content, status: task.status })),
    }));
  let done = 0;
  let total = 0;
  for (const group of groups) {
    for (const task of group.tasks) {
      total++;
      if (task.status === "completed") done++;
    }
  }
  return { groups, done, total };
}
