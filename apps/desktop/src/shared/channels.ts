/** IPC channel names shared by main and preload. */
export const SIDECAR_GET_STATUS = "sidecar:get-status";
export const SIDECAR_RESTART = "sidecar:restart";
export const SIDECAR_STATUS = "sidecar:status";
export const SESSION_PICK_DIRECTORY = "session:pick-directory";
export const SESSION_CREATE = "session:create";
export const SESSION_PROMPT = "session:prompt";
export const SESSION_CANCEL = "session:cancel";
export const SESSION_MODELS = "session:models";
export const SESSION_SET_MODEL = "session:set-model";
export const SESSION_SET_THINKING = "session:set-thinking";
export const SESSION_REMOVE_QUEUED = "session:remove-queued";
export const SESSION_FILES = "session:files";
export const SESSION_SUBSCRIBE = "session:subscribe";
export const SESSION_UNSUBSCRIBE = "session:unsubscribe";
export const SESSION_ANSWER_PERMISSION = "session:answer-permission";
export const SESSION_ANSWER_ASK = "session:answer-ask";
export const SESSION_SET_PLAN_MODE = "session:set-plan-mode";
export const SESSION_READ_PLAN = "session:read-plan";
export const SESSION_OP = "session:op";
/** Kills a subagent or a background job. Separate from `session:cancel`: Esc never reaches these. */
export const SUBAGENT_CANCEL = "subagent:cancel";
export const JOB_CANCEL = "job:cancel";
export const APP_OPEN_LINK = "app:open-link";
export const SESSION_LIST = "session:list";
export const SESSION_RESUME = "session:resume";
export const SESSION_FORK = "session:fork";
export const SESSION_CLOSE = "session:close";
export const SESSION_COMMANDS = "session:commands";
export const SESSION_RUN_COMMAND = "session:run-command";
/** Pushed by main when the user asks for the command palette from the application menu (⌘K). */
export const PALETTE_OPEN = "palette:open";
export const SETTINGS_LIST = "settings:list";
export const SETTINGS_SET = "settings:set";
export const SETTINGS_RESET = "settings:reset";
export const SETTINGS_REVEAL = "settings:reveal";
/** Opens the global config.yml in the system's editor; takes no path from the window. */
export const SETTINGS_OPEN_FILE = "settings:open-file";
/** Pushed by main when the user asks for the settings view from the application menu (⌘,). */
export const SETTINGS_OPEN = "settings:open";
export const MCP_LIST = "mcp:list";
export const MCP_ADD = "mcp:add";
export const MCP_UPDATE = "mcp:update";
export const MCP_REMOVE = "mcp:remove";
export const MCP_SET_ENABLED = "mcp:set-enabled";
export const MCP_REVEAL = "mcp:reveal";
export const SKILLS_LIST = "skills:list";
export const SKILLS_SET_ENABLED = "skills:set-enabled";
