import { useEffect, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { SessionView } from "./SessionView";

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
      className="flex w-[40rem] max-w-full flex-col gap-2 rounded-sm bg-bg-elevated p-4 text-size-sm"
    >
      {status.state === "starting" && <p>Sidecar: starting…</p>}
      {status.state === "ready" && (
        <p>
          Sidecar: ready · omp {status.ompVersion} · sidecar {status.sidecarVersion}
        </p>
      )}
      {status.state === "ready" && status.mode === "read_only" && status.schema && (
        <p
          role="alert"
          data-testid="read-only-notice"
          className="rounded-sm border border-accent p-2 font-medium"
        >
          Read-only mode: the shared omp database is schema v{status.schema.onDisk}, but this app
          supports v{status.schema.expected}. Update omp-app to make changes.
        </p>
      )}
      {status.state === "failed" && (
        <>
          <p role="alert" className="font-medium">
            Sidecar: failed · {status.error}
          </p>
          <p className="text-size-xs text-text-secondary">Last sidecar output:</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-sm bg-bg-base p-2 text-size-xs text-text-secondary">
            {status.logTail.length > 0 ? status.logTail.join("\n") : "(no output)"}
          </pre>
        </>
      )}
      <div>
        <button
          type="button"
          onClick={() => void window.omp.sidecar.restart()}
          className="rounded-sm bg-accent px-3 py-1 text-on-accent"
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
    <main className="flex h-screen flex-col items-center gap-3 bg-bg-base p-4 font-text text-text-primary">
      <h1 className="text-size-display text-text-secondary">omp-app</h1>
      <p data-testid="bridge-versions" className="text-size-sm text-text-secondary">
        electron {electron} · chrome {chrome}
      </p>
      <SidecarPanel status={status} />
      <SessionView sidecar={status} />
    </main>
  );
}
