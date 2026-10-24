import pkg from "../package.json" with { type: "json" };

/** Version of this sidecar build. */
export const SIDECAR_VERSION: string = pkg.version;
