/** Dependency boundaries from ADR 0003. */
module.exports = {
  forbidden: [
    {
      name: "not-to-unresolvable",
      comment:
        "an import that cannot be resolved (e.g. an undeclared workspace package) bypasses the path rules",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "protocol-no-internal-specifier",
      severity: "error",
      from: { path: "^packages/protocol/src" },
      to: { path: "^@omp-app/" },
    },
    {
      name: "sidecar-no-ui-desktop-specifier",
      severity: "error",
      from: { path: "^packages/sidecar/src" },
      to: { path: "^@omp-app/(ui|desktop)" },
    },
    {
      name: "ui-no-app-specifier",
      severity: "error",
      from: { path: "^packages/ui/src" },
      to: { path: "^@omp-app/" },
    },
    {
      name: "desktop-no-sidecar-specifier",
      severity: "error",
      from: { path: "^apps/desktop/src" },
      to: { path: "^@omp-app/sidecar" },
    },
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
