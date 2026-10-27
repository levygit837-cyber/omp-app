import type {
  SettingScope,
  SettingsChange,
  SettingsListing,
  SettingsTarget,
} from "@omp-app/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeError } from "./errors";
import { mergeEntries, type Parsed } from "./settings-model";

export type SettingsState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly listing: SettingsListing };

/** What a write came to: the reason it was refused, or a saved value with a caveat. */
export interface WriteOutcome {
  /** The reason the value was not saved; `null` when it was. */
  readonly refused: string | null;
  /** Saved, but running sessions that could not reload keep their previous value. */
  readonly notice: string | null;
}

/** Sentence for the row; the sidecar sends only a count, never omp's own message. */
export function reloadNotice(failed: number): string {
  return failed === 1
    ? "Saved. 1 running session could not reload it and keeps the old value."
    : `Saved. ${failed} running sessions could not reload it and keep the old value.`;
}

export interface SettingsActions {
  set(id: string, value: unknown): Promise<WriteOutcome>;
  reset(id: string): Promise<WriteOutcome>;
  /** The stored value of one secret, read from the file of `from`. */
  reveal(id: string, from: SettingScope): Promise<Parsed<string>>;
  reload(): void;
}

function targetOf(scope: SettingScope, sessionId: string | undefined): SettingsTarget {
  return sessionId === undefined ? { scope } : { scope, sessionId };
}

/**
 * The listing of one scope, kept in sync with what the sidecar says each write changed.
 * `sessionId` names the session whose project the Project scope edits (the sidecar knows its
 * directory); without it only the global scope can be listed.
 * The returned actions keep one identity for the life of the screen, so memoized rows
 * do not re-render when the parent does.
 */
export function useSettings(
  scope: SettingScope,
  sessionId: string | undefined,
): [SettingsState, SettingsActions] {
  const [state, setState] = useState<SettingsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // A response for a scope or session the user already left must not overwrite the screen.
  const generation = useRef(0);
  const latest = useRef({ scope, sessionId });
  latest.current = { scope, sessionId };

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a retry trigger.
  useEffect(() => {
    const mine = ++generation.current;
    setState({ status: "loading" });
    window.omp.settings.list(targetOf(scope, sessionId)).then(
      (listing) => {
        if (mine === generation.current) setState({ status: "ready", listing });
      },
      (error: unknown) => {
        if (mine === generation.current)
          setState({ status: "failed", message: describeError(error) });
      },
    );
  }, [scope, sessionId, attempt]);

  const actions = useMemo<SettingsActions>(() => {
    const write = async (
      run: (target: SettingsTarget) => Promise<SettingsChange>,
    ): Promise<WriteOutcome> => {
      const mine = generation.current;
      try {
        const change = await run(targetOf(latest.current.scope, latest.current.sessionId));
        if (!change.ok) return { refused: change.message, notice: null };
        if (mine === generation.current) {
          setState((prev) =>
            prev.status === "ready"
              ? { status: "ready", listing: mergeEntries(prev.listing, change.entries) }
              : prev,
          );
        }
        return {
          refused: null,
          notice: change.reloadFailed === undefined ? null : reloadNotice(change.reloadFailed),
        };
      } catch (error) {
        return { refused: describeError(error), notice: null };
      }
    };
    return {
      set: (id, value) => write((target) => window.omp.settings.set(target, id, value)),
      reset: (id) => write((target) => window.omp.settings.reset(target, id)),
      reveal: async (id, from) => {
        try {
          const value = await window.omp.settings.reveal(
            targetOf(from, latest.current.sessionId),
            id,
          );
          return { ok: true, value };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },
      reload: () => setAttempt((n) => n + 1),
    };
  }, []);

  return [state, actions];
}
