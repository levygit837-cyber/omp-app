import {
  type ModelOption,
  type QueueState,
  SESSION_BUSY_MESSAGE,
  type SessionOp,
  type SessionViewModel,
} from "@omp-app/protocol";

/**
 * The fake sidecar's side of the prompt controls (#14): model and thinking switching, steering,
 * the follow-up queue and the `@` file listing. Knobs:
 * - FAKE_MODELS=none: no credentials, so `session.models` is empty.
 * - FAKE_FILES=<a,b,c>: the project files the `@` picker can list (default a small tree).
 */

export const FAKE_MODELS: readonly ModelOption[] = [
  {
    id: "anthropic/claude-opus-5-5",
    provider: "anthropic",
    name: "Claude Opus 5.5",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "anthropic/claude-haiku-5-5",
    provider: "anthropic",
    name: "Claude Haiku 5.5",
    efforts: [],
  },
  { id: "openai/gpt-5", provider: "openai", name: "GPT-5", efforts: ["low", "medium", "high"] },
];

const DEFAULT_FILES = [
  "README.md",
  "package.json",
  "src/",
  "src/index.ts",
  "src/server.ts",
  "docs/guide.md",
];

/** Time a steer waits in the queue before the turn picks it up. */
const STEER_DELAY_MS = 400;

export interface PromptTarget {
  readonly vm: SessionViewModel;
  /** Whether a turn is running. */
  readonly turning: boolean;
  emit: (op: SessionOp) => void;
  /** Starts a turn for a prompt that arrived while idle, or one delivered from the queue. */
  start: (text: string) => void;
  nextId: () => string;
}

const queueWith = (queue: QueueState, patch: Partial<QueueState>): QueueState => ({
  ...queue,
  ...patch,
});

export function fakeModels(): readonly ModelOption[] {
  return process.env.FAKE_MODELS === "none" ? [] : FAKE_MODELS;
}

export function fakeFiles(query: string): string[] {
  const all = process.env.FAKE_FILES ? process.env.FAKE_FILES.split(",") : DEFAULT_FILES;
  const needle = query.toLowerCase();
  return all.filter((path) => path.toLowerCase().includes(needle));
}

/**
 * The files the fake "reads" for a prompt that starts a turn: the `@path` / `@"a b"` tokens, as
 * omp's `extractFileMentions` finds them. A joined steer or follow-up is never passed through
 * here, because omp only expands references in `#prompt` (`agent-session.ts:8482` [V]).
 */
export function filesRead(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s@"]+))/g)) {
    found.push(match[1] ?? match[2] ?? "");
  }
  return [...new Set(found.filter((path) => path !== ""))];
}

/** A prompt while a turn runs: a steer joins it, a follow-up waits for its end. */
export function joinTurn(target: PromptTarget, text: string, delivery: string): void {
  const { queue } = target.vm;
  if (delivery === "followUp") {
    target.emit({
      type: "queue.set",
      queue: queueWith(queue, { followUp: [...queue.followUp, text] }),
    });
    return;
  }
  target.emit({
    type: "queue.set",
    queue: queueWith(queue, { steering: [...queue.steering, text] }),
  });
  setTimeout(() => {
    const now = target.vm.queue;
    if (!now.steering.includes(text)) return;
    target.emit({
      type: "queue.set",
      queue: queueWith(now, { steering: now.steering.filter((entry) => entry !== text) }),
    });
    target.emit({
      type: "item.add",
      item: { kind: "user", id: target.nextId(), text, steered: true },
    });
  }, STEER_DELAY_MS);
}

/** Called when a turn ends: the first follow-up becomes the next turn. */
export function drainFollowUp(target: PromptTarget): void {
  const [next, ...rest] = target.vm.queue.followUp;
  if (next === undefined) return;
  target.emit({ type: "queue.set", queue: queueWith(target.vm.queue, { followUp: rest }) });
  target.start(next);
}

export function removeQueued(target: PromptTarget, queue: string, text: string): boolean {
  const current = target.vm.queue;
  const key = queue === "followUp" ? "followUp" : "steering";
  const index = current[key].indexOf(text);
  if (index === -1) return false;
  target.emit({
    type: "queue.set",
    queue: queueWith(current, { [key]: current[key].filter((_, at) => at !== index) }),
  });
  return true;
}

/** Throws the sidecar's busy message while a turn runs, as the real handler does. */
export function requireIdle(target: PromptTarget): void {
  if (target.turning) throw new Error(SESSION_BUSY_MESSAGE);
}

export function setModel(target: PromptTarget, id: string): void {
  const model = fakeModels().find((candidate) => candidate.id === id);
  if (!model) throw new Error(`unknown model: ${id}`);
  target.emit({ type: "model.set", model: model.id });
  const kept = target.vm.thinking;
  target.emit({
    type: "thinking.set",
    thinking: model.efforts.length === 0 ? null : kept && kept !== "off" ? kept : "off",
  });
}

export function setThinking(target: PromptTarget, level: string): void {
  const model = fakeModels().find((candidate) => candidate.id === target.vm.model);
  const accepted = model ? ["off", "auto", ...model.efforts] : [];
  if (!accepted.includes(level)) throw new Error(`unknown thinking level: ${level}`);
  target.emit({ type: "thinking.set", thinking: level });
}
