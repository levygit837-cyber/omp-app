/** IPC channel names shared by main and preload. */
export const SIDECAR_GET_STATUS = "sidecar:get-status";
export const SIDECAR_RESTART = "sidecar:restart";
export const SIDECAR_STATUS = "sidecar:status";
export const SESSION_PICK_DIRECTORY = "session:pick-directory";
export const SESSION_CREATE = "session:create";
export const SESSION_PROMPT = "session:prompt";
export const SESSION_CANCEL = "session:cancel";
export const SESSION_SUBSCRIBE = "session:subscribe";
export const SESSION_UNSUBSCRIBE = "session:unsubscribe";
export const SESSION_ANSWER_PERMISSION = "session:answer-permission";
export const SESSION_ANSWER_ASK = "session:answer-ask";
export const SESSION_OP = "session:op";
export const APP_OPEN_LINK = "app:open-link";
export const SESSION_LIST = "session:list";
export const SESSION_RESUME = "session:resume";
export const SESSION_FORK = "session:fork";
export const SESSION_CLOSE = "session:close";
export const SETTINGS_LIST = "settings:list";
export const SETTINGS_SET = "settings:set";
export const SETTINGS_RESET = "settings:reset";
export const SETTINGS_REVEAL = "settings:reveal";
/** Opens the global config.yml in the system's editor; takes no path from the window. */
export const SETTINGS_OPEN_FILE = "settings:open-file";
/** Pushed by main when the user asks for the settings view from the application menu (⌘,). */
export const SETTINGS_OPEN = "settings:open";
