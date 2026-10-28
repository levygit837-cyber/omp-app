import type {
  McpField,
  McpListing,
  McpSecretRef,
  McpServerInput,
  SettingScope,
  SettingsTarget,
  SkillsListing,
} from "@omp-app/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeError, describeSidecarText } from "./errors";
import type { Parsed } from "./settings-model";

export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

/** What a write came to: the reason it was refused (and the field it is about), or nothing. */
export interface Outcome {
  readonly refused: string | null;
  readonly field?: McpField;
}

const SAVED: Outcome = { refused: null };

function targetOf(scope: SettingScope, sessionId: string | undefined): SettingsTarget {
  return sessionId === undefined ? { scope } : { scope, sessionId };
}

/**
 * A listing that reloads when its inputs change and ignores answers for inputs the person has
 * already left. `apply` puts a write's answer into the state.
 */
function useListing<T>(
  load: () => Promise<T>,
  inputs: readonly unknown[],
): {
  state: Loadable<T>;
  generation: { readonly current: number };
  apply: (value: T) => void;
  reload: () => void;
} {
  const [state, setState] = useState<Loadable<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `inputs` and `attempt` are the triggers.
  useEffect(() => {
    const mine = ++generation.current;
    setState({ status: "loading" });
    loader.current().then(
      (value) => {
        if (mine === generation.current) setState({ status: "ready", value });
      },
      (error: unknown) => {
        if (mine === generation.current)
          setState({ status: "failed", message: describeError(error) });
      },
    );
  }, [...inputs, attempt]);

  return {
    state,
    generation,
    apply: (value) => setState({ status: "ready", value }),
    reload: () => setAttempt((n) => n + 1),
  };
}

export interface McpActions {
  add(server: McpServerInput): Promise<Outcome>;
  update(server: McpServerInput): Promise<Outcome>;
  remove(name: string): Promise<Outcome>;
  setEnabled(name: string, enabled: boolean): Promise<Outcome>;
  /** One stored value of a server, read on demand from the file of this scope. */
  reveal(name: string, secret: McpSecretRef): Promise<Parsed<string>>;
  reload(): void;
}

/**
 * The servers of one scope. The write actions keep one identity per scope and session, and a
 * write's answer replaces the listing, so the list is what the file holds after the write.
 */
export function useMcp(
  scope: SettingScope,
  sessionId: string | undefined,
): [Loadable<McpListing>, McpActions] {
  const listing = useListing(
    () => window.omp.mcp.list(targetOf(scope, sessionId)),
    [scope, sessionId],
  );
  const latest = useRef({ scope, sessionId, ...listing });
  latest.current = { scope, sessionId, ...listing };

  const actions = useMemo<McpActions>(() => {
    const write = async (
      run: (target: SettingsTarget) => ReturnType<typeof window.omp.mcp.add>,
    ): Promise<Outcome> => {
      const { generation, apply, scope: s, sessionId: id } = latest.current;
      const mine = generation.current;
      try {
        const change = await run(targetOf(s, id));
        if (!change.ok) {
          const refused = describeSidecarText(change.message);
          return change.field === undefined ? { refused } : { refused, field: change.field };
        }
        if (mine === generation.current) apply(change.listing);
        return SAVED;
      } catch (error) {
        return { refused: describeError(error) };
      }
    };
    return {
      add: (server) => write((t) => window.omp.mcp.add(t, server)),
      update: (server) => write((t) => window.omp.mcp.update(t, server)),
      remove: (name) => write((t) => window.omp.mcp.remove(t, name)),
      setEnabled: (name, enabled) => write((t) => window.omp.mcp.setEnabled(t, name, enabled)),
      reveal: async (name, secret) => {
        const { scope: s, sessionId: id } = latest.current;
        try {
          return { ok: true, value: await window.omp.mcp.reveal(targetOf(s, id), name, secret) };
        } catch (error) {
          return { ok: false, message: describeError(error) };
        }
      },
      reload: () => latest.current.reload(),
    };
  }, []);

  return [listing.state, actions];
}

export interface SkillsActions {
  setEnabled(name: string, enabled: boolean): Promise<Outcome>;
  reload(): void;
}

export function useSkills(sessionId: string | undefined): [Loadable<SkillsListing>, SkillsActions] {
  const listing = useListing(() => window.omp.skills.list(sessionId), [sessionId]);
  const latest = useRef({ sessionId, ...listing });
  latest.current = { sessionId, ...listing };

  const actions = useMemo<SkillsActions>(
    () => ({
      setEnabled: async (name, enabled) => {
        const { generation, apply, sessionId: id } = latest.current;
        const mine = generation.current;
        try {
          const change = await window.omp.skills.setEnabled(name, enabled, id);
          if (!change.ok) return { refused: describeSidecarText(change.message) };
          if (mine === generation.current) apply(change.listing);
          return SAVED;
        } catch (error) {
          return { refused: describeError(error) };
        }
      },
      reload: () => latest.current.reload(),
    }),
    [],
  );

  return [listing.state, actions];
}
