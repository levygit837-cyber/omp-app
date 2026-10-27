import type { SessionStatus } from "@omp-app/protocol";
import { useEffect, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import type { EnginePhase } from "./composer-state";

/** How long "omp engine is back" stays on screen after a restart. */
export const BACK_NOTICE_MS = 6000;

/** What the window knows about the engine beyond its current status. */
export interface EngineTrack {
  readonly state: SidecarStatus["state"];
  /** When the engine entered `state`, in epoch ms. */
  readonly since: number;
  /** Starting again after it ran or failed, as opposed to the first start of this window. */
  readonly restarting: boolean;
  /** It reached `ready` at least once, so a failure is "stopped", not "stopped while starting". */
  readonly wasReady: boolean;
  /** It just came back from a restart; cleared by the caller after {@link BACK_NOTICE_MS}. */
  readonly back: boolean;
}

/** Pure transition, so the wording rules (first start vs restart vs back) can be tested. */
export function trackEngine(
  previous: EngineTrack | null,
  state: SidecarStatus["state"],
  now: number,
): EngineTrack {
  if (!previous) {
    return { state, since: now, restarting: false, wasReady: state === "ready", back: false };
  }
  if (previous.state === state) return previous;
  return {
    state,
    since: now,
    restarting: state === "starting",
    wasReady: previous.wasReady || state === "ready",
    back: state === "ready" && previous.restarting,
  };
}

export function enginePhase(track: EngineTrack): EnginePhase {
  if (track.state === "failed") return "failed";
  if (track.state === "ready") return "ready";
  return track.restarting ? "restarting" : "starting";
}

/**
 * A turn does not run on a dead engine. The sidecar cannot say so (it is gone), so a session that
 * was streaming is shown idle while the engine is not ready: no caret, no spinner.
 */
export function shownStatus(
  status: SessionStatus | undefined,
  engine: EnginePhase,
): SessionStatus | undefined {
  return status === "streaming" && engine !== "ready" ? "idle" : status;
}

export function useEngine(status: SidecarStatus): EngineTrack {
  const [track, setTrack] = useState<EngineTrack>(() =>
    trackEngine(null, status.state, Date.now()),
  );
  const state = status.state;

  useEffect(() => {
    setTrack((previous) => trackEngine(previous, state, Date.now()));
  }, [state]);

  const back = track.back;
  const since = track.since;
  useEffect(() => {
    if (!back) return;
    const timer = setTimeout(
      () =>
        setTrack((current) => (current.since === since ? { ...current, back: false } : current)),
      BACK_NOTICE_MS,
    );
    return () => clearTimeout(timer);
  }, [back, since]);

  return track;
}

/** Milliseconds since `since`, refreshed once a second while `active`. */
export function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? 0 : now - since;
}

/** When the current run started, or null while nothing runs. */
export function useRunStart(running: boolean): number | null {
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => {
    setSince(running ? Date.now() : null);
  }, [running]);
  return since;
}

/** A run shows its timer only once it has taken a while (`--motion-timer-show-after`). */
export const TIMER_SHOW_AFTER_MS = 10_000;
