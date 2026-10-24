/** Dependency boundaries from ADR 0003. */
const NODE_BUILTINS =
  "^(node:|(assert|buffer|child_process|cluster|crypto|dgram|dns|events|fs|http|http2|https|net|os|path|perf_hooks|process|readline|stream|tls|url|util|v8|vm|worker_threads|zlib)(/|$))";

module.exports = {
  forbidden: [
    {
      name: "protocol-imports-nothing",
      comment: "protocol has no dependencies",
      severity: "error",
      from: { path: "^packages/protocol/src" },
      to: {
        path: "^(apps|packages/(sidecar|ui))/|^node_modules/|^@omp-app/",
        pathNot: "^packages/protocol/",
      },
    },
    {
      name: "protocol-no-packages",
      severity: "error",
      from: { path: "^packages/protocol/src" },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-peer", "npm-optional", "core"] },
    },
    {
      name: "sidecar-only-protocol",
      comment: "sidecar may use protocol (and omp, later), never ui or desktop",
      severity: "error",
      from: { path: "^packages/sidecar/src" },
      to: { path: "^(apps/|packages/ui/)" },
    },
    {
      name: "ui-nothing-app-specific",
      severity: "error",
      from: { path: "^packages/ui/src" },
      to: { path: "^(apps/|packages/(protocol|sidecar)/)" },
    },
    {
      name: "desktop-never-sidecar",
      comment: "desktop uses protocol + ui, never sidecar or omp",
      severity: "error",
      from: { path: "^apps/desktop/src" },
      to: { path: "^packages/sidecar/" },
    },
    {
      name: "desktop-never-omp",
      severity: "error",
      from: { path: "^apps/desktop/src" },
      to: { path: "@oh-my-pi/" },
    },
    {
      name: "renderer-no-node",
      severity: "error",
      from: { path: "^apps/desktop/src/renderer" },
      to: { path: NODE_BUILTINS },
    },
    {
      name: "renderer-no-node-core",
      severity: "error",
      from: { path: "^apps/desktop/src/renderer" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "renderer-no-electron",
      severity: "error",
      from: { path: "^apps/desktop/src/renderer" },
      to: { path: "(^|/)node_modules/electron(/|$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.base.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
