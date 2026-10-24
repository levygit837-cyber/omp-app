/** Surface exposed by the preload script as `window.omp`. Types only: safe to import anywhere. */
export type OmpBridge = {
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
  };
};
