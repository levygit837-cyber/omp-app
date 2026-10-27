# Evidence for #12 (permission and ask dialogs)

Screenshots are the real Electron app at 1440x900 driven through CDP (port 9342) against the
fake sidecar (`FAKE_REQUEST=permission|ask|form|queue`, `FAKE_HOLD=1`). `scripts/` holds the
driver. Side-by-side files: design export on the left, real app on the right.

The live run against the real omp is not a screenshot: `packages/sidecar/scripts/live.ts`
(scenarios reject, allow, ask) printed `live: all scenarios passed`.
