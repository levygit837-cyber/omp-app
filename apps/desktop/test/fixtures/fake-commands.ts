import {
  CONFIRM_REQUIRED_MESSAGE,
  type CommandItem,
  confirmationOf,
  type SlashCommand,
  UNKNOWN_COMMAND_MESSAGE,
} from "@omp-app/protocol";

/** A few of the real builtins, with their real hints, for the palette. Not the whole 46. */
export const FAKE_COMMANDS: readonly SlashCommand[] = [
  { name: "model", aliases: ["models"], description: "Select the model", subcommands: [] },
  {
    name: "effort",
    aliases: ["thinking"],
    description: "Set the thinking effort",
    hint: "[level]",
    subcommands: [{ name: "low" }, { name: "medium" }, { name: "high" }],
  },
  {
    name: "switch",
    aliases: [],
    description: "Switch to another model",
    hint: "[model]",
    subcommands: [],
  },
  {
    name: "usage",
    aliases: [],
    description: "Show provider usage",
    hint: "[show|reset]",
    subcommands: [{ name: "show" }, { name: "reset", usage: "[account]" }],
    confirmVerbs: [
      {
        verbs: ["reset"],
        because: "Spends a saved provider reset. It cannot be undone.",
        destructive: true,
      },
    ],
  },
  {
    name: "session",
    aliases: [],
    description: "Show or delete this session",
    hint: "[info|delete]",
    subcommands: [{ name: "info" }, { name: "delete" }],
    confirmVerbs: [
      {
        verbs: ["delete"],
        because: "Deletes this session’s file and its artifacts from disk. It cannot be undone.",
        destructive: true,
      },
    ],
  },
  {
    name: "compact",
    aliases: [],
    description: "Summarize and shrink the context",
    hint: "[soft|remote] [focus]",
    subcommands: [],
  },
  {
    name: "export",
    aliases: [],
    description: "Export this session to an HTML file",
    hint: "[--themes] [path]",
    subcommands: [],
    confirm: { because: "Writes this session to an HTML file on this computer." },
  },
  {
    name: "mcp",
    aliases: [],
    description: "Manage MCP servers",
    hint: "<subcommand>",
    subcommands: [
      { name: "list", description: "List the servers" },
      { name: "add", description: "Add a server", usage: "<name>" },
    ],
  },
];

const nameOf = (line: string): string => line.slice(1).split(/\s+/, 1)[0] ?? "";

/** What a line prints, or null when it names no fake command. */
export function fakeCommandOutput(line: string): string | null {
  const word = nameOf(line).toLowerCase();
  const command = FAKE_COMMANDS.find((c) => c.name === word || c.aliases.includes(word));
  if (!command) return null;
  const args = line.slice(1 + word.length).trim();
  if (command.name === "usage") return "Provider usage\n  anthropic  42% of the 5 h window";
  if (command.name === "mcp" && args === "") return "Usage: /mcp <subcommand>";
  return `/${command.name}${args === "" ? "" : ` ${args}`} done`;
}

/** The refusal the real sidecar gives a line that needs a confirmation and came without one. */
export function missingConfirmation(line: string, confirmed: boolean): Error | null {
  if (confirmed) return null;
  const word = nameOf(line).toLowerCase();
  const command = FAKE_COMMANDS.find((c) => c.name === word || c.aliases.includes(word));
  if (!command || confirmationOf(command, line.slice(1 + word.length)) === null) return null;
  return new Error(`${CONFIRM_REQUIRED_MESSAGE}: ${line}`);
}

export function unknownCommand(line: string): Error {
  return new Error(`${UNKNOWN_COMMAND_MESSAGE}: ${line}`);
}

export const commandItem = (id: string, text: string, now: number): CommandItem => ({
  kind: "command",
  id,
  text,
  state: "running",
  output: "",
  startedAt: now,
});
