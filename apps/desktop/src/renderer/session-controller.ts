import { useEffect, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { describeError } from "./errors";
import { replicas } from "./session-hooks";
import { SessionLostError } from "./session-store";

/** Survives a window reload (same tab), so a reload re-attaches to the running session. */
const STORAGE_KEY = "omp-app.sessionId";

export const message = describeError;

export interface SessionController {
  /** The session in use, or null. */
  readonly sessionId: string | null;
  /**
   * True once the sidecar stopped knowing the session (it restarted): sessions do not survive
   * that. The replica is already gone then, so there is no timeline to show.
   */
  readonly lost: boolean;
  /** Why the last attempt to start a session failed. */
  readonly error: string | null;
  /** Pick a directory and start a session in it. */
  start(): Promise<void>;
}

/** Pick a directory, start a session in it, re-attach to it after a reload or a sidecar restart. */
export function useSessionController(sidecar: SidecarStatus): SessionController {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = sidecar.state === "ready";

  // After a reload, or when the sidecar comes back after a restart: subscribe again to the
  // session in use. The snapshot restores it; "unknown session" means it is gone for good.
  useEffect(() => {
    if (!ready) return;
    const id = sessionStorage.getItem(STORAGE_KEY);
    if (!id) return;
    replicas.open(id).then(
      () => {
        setSessionId(id);
        setLost(false);
      },
      (e: unknown) => {
        if (!(e instanceof SessionLostError)) return setError(message(e));
        sessionStorage.removeItem(STORAGE_KEY);
        setSessionId(null);
        setLost(true);
      },
    );
  }, [ready]);

  const start = async () => {
    setError(null);
    try {
      const dir = await window.omp.session.pickDirectory();
      if (!dir) return;
      const id = await window.omp.session.create(dir);
      await replicas.open(id);
      const previous = sessionId;
      sessionStorage.setItem(STORAGE_KEY, id);
      setSessionId(id);
      setLost(false);
      if (previous) await replicas.close(previous).catch(() => undefined);
    } catch (e) {
      setError(message(e));
    }
  };

  return { sessionId, lost, error, start };
}
