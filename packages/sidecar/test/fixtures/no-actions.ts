/** The session-action members of a `SessionControl` for fakes that never clear, delete or pause. */
export const noActions = {
  clearContext: (): never => {
    throw new Error("this fake clears no context");
  },
  deletePreview: (): never => {
    throw new Error("this fake deletes no session");
  },
  deleteSession: (): never => {
    throw new Error("this fake deletes no session");
  },
  pauseState: () => ({ paused: false }),
  setPaused: (): never => {
    throw new Error("this fake pauses nothing");
  },
};
