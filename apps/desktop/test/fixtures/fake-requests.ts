/**
 * What the fake sidecar does when FAKE_REQUEST is set: during a turn it raises a permission, an
 * ask form or both, and holds the turn until they are answered (or the turn is cancelled).
 * Values: `permission`, `ask` (select + other), `form` (multi + confirm + input) and `queue`
 * (a permission and an ask at once, so the second waits behind the first) and `plan` (the plan
 * approval omp asks for once `elicitation.form` is declared, with its multi-line message).
 * Lives apart from fake-sidecar.ts so that file only needs a hook.
 */
import {
  decisionForPermission,
  isAskContent,
  type PendingRequest,
  type PermissionKind,
  type SessionOp,
  type SessionViewModel,
} from "@omp-app/protocol";

/** What this script needs of a fake session. */
export interface RequestSession {
  readonly vm: SessionViewModel;
}
type Emit = (op: SessionOp) => void;

const SCRIPT = process.env.FAKE_REQUEST;

function option(kind: PermissionKind, name: string) {
  return { optionId: kind, name, kind };
}

const PERMISSION = (): PendingRequest => ({
  kind: "permission",
  id: "fake-perm",
  toolCallId: "fake-call-1",
  title: "rm -rf node_modules/.cache && bun install",
  toolKind: "execute",
  payload: "rm -rf node_modules/.cache && bun install --frozen-lockfile",
  // Real omp builds bash locations from `args.path` only, so a command carries no path row
  // [V] acp-permission-gate.ts:127.
  paths: [],
  options: [
    option("allow_once", "Allow once"),
    option("allow_always", "Always allow"),
    option("reject_once", "Reject"),
    option("reject_always", "Always reject"),
  ],
  raisedAt: Date.now(),
});

const ASK_SELECT = (): PendingRequest => ({
  kind: "ask",
  id: "fake-ask",
  message: "Which color do you prefer?",
  fields: [
    {
      key: "q0",
      type: "select",
      title: "Which color do you prefer?",
      required: false,
      choices: [
        { value: "azul", label: "azul", description: "calm, cold" },
        { value: "verde", label: "verde" },
        { value: "vermelho", label: "vermelho" },
      ],
      otherKey: "q0__other",
      otherLabel: "Other",
      default: "verde",
    },
  ],
  raisedAt: Date.now(),
});

const ASK_FORM = (): PendingRequest => ({
  kind: "ask",
  id: "fake-form",
  message: "Answer 3 questions",
  fields: [
    {
      key: "q0",
      type: "multi",
      title: "Which checks should run?",
      required: false,
      choices: [
        { value: "lint", label: "lint" },
        { value: "typecheck", label: "typecheck" },
        { value: "test", label: "test" },
      ],
    },
    { key: "q1", type: "confirm", title: "Run them in parallel?", required: true },
    {
      key: "q2",
      type: "input",
      title: "Branch name",
      description: "e.g. fix/login",
      required: true,
    },
  ],
  raisedAt: Date.now(),
});

// omp's plan approval: acp-agent.ts:2411-2425 (the message holds the first 12 lines of the plan).
const PLAN = (): PendingRequest => ({
  kind: "ask",
  id: "fake-plan",
  message:
    'Approve plan "Rename the "config" loader" and start implementation?\n\n1. Read src/config.ts\n2. Rename `load` to `loadConfig`\n\n   - keep the old name exported\n3. Update callers in src/cli and src/server\n4. Run the tests\n…',
  fields: [
    {
      key: "value",
      type: "select",
      required: true,
      choices: [
        { value: "Approve and execute", label: "Approve and execute" },
        { value: "Refine plan", label: "Refine plan" },
      ],
    },
  ],
  raisedAt: Date.now(),
});

const requestsFor = (): PendingRequest[] =>
  SCRIPT === "permission"
    ? [PERMISSION()]
    : SCRIPT === "ask"
      ? [ASK_SELECT()]
      : SCRIPT === "plan"
        ? [PLAN()]
        : SCRIPT === "form"
          ? [ASK_FORM()]
          : SCRIPT === "queue"
            ? [PERMISSION(), ASK_SELECT()]
            : [];

/** Resolvers of the requests still waiting, by session id then request id. */
const waiting = new Map<string, Map<string, () => void>>();
let decisions = 0;

/** True when the script applies to the turn that is starting. */
export const scripted = (): boolean => requestsFor().length > 0;

/** Raises the scripted requests and resolves once every one is answered or withdrawn. */
export async function raiseRequests(session: RequestSession, emit: Emit): Promise<void> {
  const mine = new Map<string, () => void>();
  waiting.set(session.vm.id, mine);
  const done: Promise<void>[] = [];
  for (const request of requestsFor()) {
    // A proposal only happens in plan mode: omp rejects `xd://propose` otherwise.
    if (request.id === "fake-plan" && !session.vm.plan.enabled)
      emit({ type: "plan.set", plan: { enabled: true, planFile: "local://PLAN.md" } });
    const gate = Promise.withResolvers<void>();
    mine.set(request.id, gate.resolve);
    done.push(gate.promise);
    emit({ type: "request.add", request });
  }
  await Promise.all(done);
}

/** Settles one request the way the real sidecar does, leaving a one-line decision. */
export function answerRequest(
  session: RequestSession,
  emit: Emit,
  requestId: string,
  how: { permission: PermissionKind } | { ask: "accept" | "decline"; content?: unknown },
): boolean {
  const resolve = waiting.get(session.vm.id)?.get(requestId);
  const request = session.vm.pending.find((r) => r.id === requestId);
  if (!resolve || !request) return false;
  waiting.get(session.vm.id)?.delete(requestId);
  const subject =
    request.kind === "permission" ? request.title : (request.message.split("\n")[0] ?? "");
  const outcome =
    "permission" in how
      ? decisionForPermission(how.permission)
      : how.ask === "accept"
        ? "answered"
        : "cancelled";
  // Like the real registry: the tool class rides along, and an answer is put in words.
  const toolKind = request.kind === "permission" ? request.toolKind : undefined;
  const detail =
    "ask" in how && how.ask === "accept" && isAskContent(how.content)
      ? Object.values(how.content).map(String).join(" · ")
      : "";
  emit({
    type: "request.settle",
    requestId,
    item: {
      kind: "decision",
      id: `d${++decisions}`,
      outcome,
      subject,
      ...(toolKind ? { toolKind } : {}),
      ...(detail ? { detail } : {}),
    },
  });
  // Like omp: only the explicit approve choice leaves plan mode (acp-agent.ts:2306-2316 [V]).
  const approved =
    "ask" in how &&
    how.ask === "accept" &&
    isAskContent(how.content) &&
    how.content.value === "Approve and execute";
  if (request.id === "fake-plan" && approved)
    emit({ type: "plan.set", plan: { enabled: false, planFile: null } });
  resolve();
  return true;
}

/** The turn ended or was cancelled: whatever still waits disappears without a line. */
export function dismissRequests(session: RequestSession, emit: Emit): void {
  const mine = waiting.get(session.vm.id);
  if (!mine) return;
  waiting.delete(session.vm.id);
  for (const [requestId, resolve] of mine) {
    emit({ type: "request.settle", requestId });
    resolve();
  }
}
