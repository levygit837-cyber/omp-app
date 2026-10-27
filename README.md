# Evidence for #12 (permission and ask dialogs)

Screenshots are the real Electron app at 1440x900 driven through CDP (port 9342) against the
fake sidecar (`FAKE_REQUEST=permission|ask|form|queue|plan`, `FAKE_HOLD=1`). `scripts/` holds the
driver. Side-by-side files: design export on the left, real app on the right.

The live run against the real omp is not a screenshot: `packages/sidecar/scripts/live.ts`
(scenarios basic, cancel, reject, allow, ask, ask-cancel) printed `live: all scenarios passed`.

After the rebase onto #33 (`main` at 87fb5dc): `rebased-permission-band.png` and `rebased-ask-band.png` are the bands in the new timeline with its right panel; `rebased-*-before-after.png` put the pre-rebase shot on the left. The live run passed all six scenarios again.
