import {
  BUILTIN_SLASH_COMMANDS_INTERNAL,
  lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import {
  type Confirmation,
  confirmationOf,
  type SlashCommand,
  type VerbConfirmation,
} from "@omp-app/protocol";

/**
 * What a builtin does beyond the session, in a sentence the palette shows before it runs one and
 * the handler enforces (`confirmationFor`). Keyed by omp's own name (aliases follow it); a `verbs`
 * entry applies to the first word after the name and wins over the command-wide one. Only what
 * a handler was read to do is here, omp 18.12.6 [V], `slash-commands/`:
 * share `builtin-collaboration.ts:293-307`, export `:180-192`, trace `:204-219`, dump `:247-282`,
 * stats `builtin-session.ts:202` + `helpers/stats-dashboard.ts:78-98`,
 * move `builtin-lifecycle.ts:711-731`, wt `:742-766`, compact `:211-262`,
 * memory `:574-612`, session `builtin-session.ts:260-295`, usage `:43-70`,
 * jobs kill `:80-117`, forget-approvals `builtin-control.ts:88-93`,
 * marketplace `builtin-marketplace.ts:112-215`, plugins `:436-455`,
 * mcp `helpers/mcp.ts:329,443-454,470`, ssh `helpers/ssh.ts:120-190`,
 * modelpreset `builtin-modes.ts:960-990`.
 * Left ungated on purpose, each read: rename, add-dir, remove-dir (the session's own title and
 * folders, undone by the opposite command), fresh (provider stream state only), pin (this
 * session's account), browser (see PR). `mcp reauth`, `memory enqueue|rebuild|sync` and
 * `modelpreset switch` were not read to the end and are not gated [I].
 */
const GATES: Readonly<
  Record<string, { confirm?: Confirmation; verbs?: readonly VerbConfirmation[] }>
> = {
  share: {
    confirm: {
      because: "Uploads this session to the share server or a secret gist and returns a link.",
    },
  },
  export: { confirm: { because: "Writes this session to an HTML file on disk." } },
  dump: {
    confirm: {
      because:
        "Returns the transcript as text and writes the model request JSON to a temporary file. With all or anon it writes a zip there instead.",
    },
  },
  trace: {
    confirm: {
      because:
        "Starts a local stats dashboard server and returns the link to this session’s trace.",
    },
  },
  stats: {
    confirm: { because: "Starts a local stats dashboard server and opens it in the browser." },
  },
  move: { confirm: { because: "Moves this session to another folder." } },
  wt: {
    confirm: {
      because: "Creates a git worktree and moves this session into it, with its changes.",
    },
  },
  compact: {
    confirm: {
      because:
        "Summarizes the conversation with the model, which costs tokens, and replaces the earlier messages in the context with the summary.",
    },
  },
  "forget-approvals": {
    confirm: {
      because:
        "Forgets every remembered file and folder approval. The next read or write asks again.",
      destructive: true,
    },
  },
  session: {
    verbs: [
      {
        verbs: ["delete"],
        because: "Deletes this session’s file and its artifacts from disk. It cannot be undone.",
        destructive: true,
      },
    ],
  },
  usage: {
    verbs: [
      {
        verbs: ["reset"],
        because:
          "Spends a saved provider rate-limit reset. A spent reset cannot be given back. Without an account it only lists them.",
        destructive: true,
      },
    ],
  },
  memory: {
    verbs: [
      {
        verbs: ["clear", "reset"],
        because: "Deletes the persisted memory data and artifacts.",
        destructive: true,
      },
    ],
  },
  jobs: {
    verbs: [{ verbs: ["kill"], because: "Cancels running background jobs of this session." }],
  },
  marketplace: {
    verbs: [
      {
        verbs: ["add", "remove", "rm", "update", "install", "uninstall", "upgrade"],
        because: "Adds, updates or removes marketplaces or the plugins installed from them.",
      },
    ],
  },
  plugins: {
    verbs: [
      {
        verbs: ["enable", "disable"],
        because: "Enables or disables an installed plugin and reloads plugins.",
      },
    ],
  },
  mcp: {
    verbs: [
      {
        verbs: ["add", "remove", "rm", "enable", "disable"],
        because: "Changes the MCP server configuration file.",
      },
    ],
  },
  ssh: {
    verbs: [
      {
        verbs: ["add", "remove", "rm"],
        because: "Changes the saved SSH hosts in the omp configuration.",
      },
    ],
  },
  modelpreset: {
    verbs: [
      {
        verbs: ["save"],
        because: "Saves the current model roles as a preset in the omp configuration.",
      },
      {
        verbs: ["delete"],
        because: "Deletes a model preset from the omp configuration.",
        destructive: true,
      },
    ],
  },
};

/**
 * The builtins omp can run without a terminal (`handle`, slash-commands/types.ts:190 [V]),
 * described the way its own ACP advertisement describes them (`acpDescription`, `acpInputHint`
 * as in `available-commands.ts:43-52` [V]). Read from the registry, not from
 * `buildAvailableSlashCommands`: that function also reloads the session's file commands
 * (`session.setSlashCommands`), a side effect a listing has no business causing.
 */
export function listBuiltinCommands(): SlashCommand[] {
  const commands: SlashCommand[] = [];
  for (const spec of BUILTIN_SLASH_COMMANDS_INTERNAL) {
    if (!spec.handle) continue;
    const hint = spec.acpInputHint ?? spec.inlineHint;
    commands.push({
      name: spec.name,
      aliases: spec.aliases ?? [],
      description: spec.acpDescription ?? spec.description,
      ...(hint ? { hint } : {}),
      subcommands: (spec.subcommands ?? []).map((s) => ({
        name: s.name,
        description: s.description,
        ...(s.usage ? { usage: s.usage } : {}),
      })),
      ...(GATES[spec.name]?.confirm ? { confirm: GATES[spec.name]?.confirm } : {}),
      ...(GATES[spec.name]?.verbs ? { confirmVerbs: GATES[spec.name]?.verbs } : {}),
    });
  }
  return commands;
}

/**
 * Whether `text` is a line omp would run as a builtin without a terminal. Anything else would
 * be sent to the model as plain text (`executeAcpBuiltinSlashCommand` returns `false`,
 * acp-builtins.ts:66 [V]), which is never what the palette means.
 */
export function isRunnableCommand(text: string): boolean {
  const parsed = parseSlashCommand(text);
  return parsed !== null && lookupBuiltinSlashCommand(parsed.name)?.handle !== undefined;
}

/**
 * The confirmation `text` needs before it runs, or null. Resolved through omp's own parser and
 * registry, so an alias (`/worktree`, `/plugin`) and the colon form (`/session:delete`) are the
 * command they stand for.
 */
export function confirmationFor(text: string): Confirmation | null {
  const parsed = parseSlashCommand(text);
  const spec = parsed && lookupBuiltinSlashCommand(parsed.name);
  const gate = spec ? GATES[spec.name] : undefined;
  return parsed && gate
    ? confirmationOf({ confirm: gate.confirm, confirmVerbs: gate.verbs }, parsed.args)
    : null;
}

/**
 * The gated builtin `text` would run as if it went down the prompt path, or null. omp's ACP agent
 * trims the prompt and then offers it to the builtins before the model (`acp-agent.ts:1188-1196`,
 * `#convertPromptBlocks` trims at `:2110` [V]), so the line is judged as omp will read it: a
 * leading space or newline is no cover. ACP dispatches one builtin per prompt: what that builtin
 * hands back goes to `AgentSession.prompt`, which looks no builtin up (no
 * `lookupBuiltinSlashCommand` in `agent-session.ts` [V]). The hop that matters is ours: the
 * runner sends a handed-back line down `session/prompt` again, where ACP would dispatch it.
 */
export function gatedPromptLine(text: string): string | null {
  const line = text.trim();
  return confirmationFor(line) === null ? null : line;
}

/** What the person is told about a line that was stopped at the gate. */
export function needsConfirmationSentence(line: string): string {
  return `${line} needs a confirmation first. Nothing was run.`;
}
