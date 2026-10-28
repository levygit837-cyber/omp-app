import type { StoredSession } from "@omp-app/protocol";
import { useEffect, useMemo, useState } from "react";
import type { EnginePhase } from "../composer-state";
import { requestFollow } from "../follow-request";
import { sessionTitle } from "../format";
import { replicas } from "../session-hooks";
import { type Action, CommandPalette } from "./CommandPalette";
import {
  type ActionRef,
  type CommandsState,
  commandsBlocked,
  type PaletteInput,
  sessionRefs,
} from "./model";

export interface PaletteHostProps {
  readonly sessionId: string | null;
  readonly stored: readonly StoredSession[] | null;
  readonly openIds: readonly string[];
  readonly openCwds: ReadonlyMap<string, string>;
  readonly engine: EnginePhase;
  readonly readOnly: boolean;
  /** A session can be started: the engine is up and not read-only. */
  readonly canOpen: boolean;
  readonly sidebarOpen: boolean;
  readonly rightOpen: boolean;
  /** `⌘,` on a Mac, which is the real accelerator of the Settings menu item; null elsewhere. */
  readonly settingsShortcut: string | null;
  /** Closes the palette; `false` when the choice moved the focus itself. */
  readonly onClose: (restoreFocus?: boolean) => void;
  readonly onSelectSession: (id: string) => void;
  readonly onNewSession: () => void;
  readonly onOpenSettings: () => void;
  readonly onToggleLeft: () => void;
  readonly onToggleRight: () => void;
  /** The session view takes the screen back (a command or a prompt answers there). */
  readonly onShowSession: () => void;
}

/** Titles of the open sessions, read once: the palette is open for a moment. */
function openTitles(ids: readonly string[]): Map<string, string> {
  const state = replicas.store.getState();
  const titles = new Map<string, string>();
  for (const id of ids) {
    const first = state.sessions[id]?.timeline.find((item) => item.kind === "user");
    titles.set(id, sessionTitle(first?.text));
  }
  return titles;
}

/**
 * Feeds the palette what the app knows and carries out what was chosen. The model decides what
 * each choice means; here it becomes a call.
 */
export function PaletteHost(props: PaletteHostProps) {
  const { sessionId, engine, readOnly } = props;
  const blocked = commandsBlocked({ sessionId, readOnly, engine });
  const [fetched, setFetched] = useState<CommandsState>({ state: "loading" });
  const titles = useMemo(() => openTitles(props.openIds), [props.openIds]);

  useEffect(() => {
    if (blocked !== null || sessionId === null) return;
    let live = true;
    window.omp.session.commands(sessionId).then(
      (commands) => live && setFetched({ state: "ready", commands }),
      () => live && setFetched({ state: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [sessionId, blocked]);

  const input = useMemo<PaletteInput>(() => {
    const actions: ActionRef[] = [];
    if (props.canOpen) actions.push({ id: "new-session", label: "New session" });
    actions.push({
      id: "open-settings",
      label: "Open settings",
      ...(props.settingsShortcut ? { shortcut: props.settingsShortcut } : {}),
    });
    actions.push({ id: "toggle-left", label: props.sidebarOpen ? "Hide sidebar" : "Show sidebar" });
    if (sessionId) {
      actions.push({
        id: "toggle-right",
        label: props.rightOpen ? "Hide details" : "Show details",
      });
    }
    return {
      sessions: sessionRefs(props.stored, props.openCwds, titles, sessionId),
      actions,
      commands: blocked ? { state: "unavailable", why: blocked } : fetched,
      canPrompt: sessionId !== null && blocked === null,
      focusedTitle: sessionId ? (titles.get(sessionId) ?? null) : null,
    };
  }, [props, titles, sessionId, blocked, fetched]);

  const carryOut = async (action: Action): Promise<void> => {
    switch (action.do) {
      case "select-session":
        props.onClose();
        props.onSelectSession(action.id);
        return;
      case "action":
        switch (action.id) {
          case "new-session":
            props.onClose();
            props.onNewSession();
            return;
          case "open-settings":
            props.onClose(false);
            props.onOpenSettings();
            return;
          case "toggle-left":
            props.onClose(false);
            props.onToggleLeft();
            return;
          case "toggle-right":
            props.onClose(false);
            props.onToggleRight();
            return;
        }
        return;
      case "prompt":
      case "run": {
        if (sessionId === null) throw new Error("sidecar is not ready");
        // A rejection stays in the palette, as a sentence, so the person can fix the line.
        if (action.do === "run")
          await window.omp.session.runCommand(sessionId, action.line, action.confirmed);
        else await window.omp.session.prompt(sessionId, action.text);
        props.onShowSession();
        requestFollow(sessionId);
        props.onClose();
        return;
      }
    }
  };

  return <CommandPalette input={input} onDismiss={() => props.onClose()} onAction={carryOut} />;
}
