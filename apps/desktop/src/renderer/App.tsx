import { useEffect, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";

function useSidecarStatus(): SidecarStatus {
  const [status, setStatus] = useState<SidecarStatus>({ state: "starting" });
  useEffect(() => {
    // Subscribe before reading, so a change between the two cannot be lost.
    const unsubscribe = window.omp.sidecar.onStatus(setStatus);
    void window.omp.sidecar.getStatus().then(setStatus);
    return unsubscribe;
  }, []);
  return status;
}

function SidecarPanel({ status }: { status: SidecarStatus }) {
  return (
    <section
      data-testid="sidecar-status"
      data-state={status.state}
      aria-live="polite"
      className="flex w-[40rem] max-w-full flex-col gap-2 rounded-control bg-surface-muted p-4 text-sm"
    >
      {status.state === "starting" && <p>Sidecar: starting…</p>}
      {status.state === "ready" && (
        <p>
          Sidecar: ready · omp {status.ompVersion} · sidecar {status.sidecarVersion}
        </p>
      )}
      {status.state === "failed" && (
        <>
          <p role="alert" className="font-medium">
            Sidecar: failed · {status.error}
          </p>
          <p className="text-xs text-text-muted">Last sidecar output:</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-control bg-surface p-2 text-xs text-text-muted">
            {status.logTail.length > 0 ? status.logTail.join("\n") : "(no output)"}
          </pre>
        </>
      )}
      <div>
        <button
          type="button"
          onClick={() => void window.omp.sidecar.restart()}
          className="rounded-control bg-accent px-3 py-1 text-surface"
        >
          Restart sidecar
        </button>
      </div>
    </section>
  );
}

export function App() {
  const { electron, chrome } = window.omp.versions;
  const status = useSidecarStatus();
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-3 bg-surface font-sans text-text">
      <h1 className="text-2xl text-text-muted">omp-app</h1>
      <p data-testid="bridge-versions" className="text-sm text-text-muted">
        electron {electron} · chrome {chrome}
      </p>
      <SidecarPanel status={status} />
    </main>
  );
}
