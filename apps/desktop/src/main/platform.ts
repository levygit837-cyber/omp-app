/** The only module allowed to hold macOS-specific code. */
export interface Platform {
  readonly name: NodeJS.Platform;
  /** Whether closing the last window should quit the app. */
  readonly quitWhenAllWindowsClosed: boolean;
}

export const platform: Platform = {
  name: process.platform,
  quitWhenAllWindowsClosed: process.platform !== "darwin",
};
