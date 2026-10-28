/** The command members of a `SessionControl` for fakes that never run a builtin. */
export const noCommands = {
  commands: () => [],
  runCommand: (): never => {
    throw new Error("this fake runs no commands");
  },
  saveCommand: (): never => {
    throw new Error("this fake saves no commands");
  },
};
