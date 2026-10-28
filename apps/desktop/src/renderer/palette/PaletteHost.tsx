import {
  pauseConfirmation,
  pauseLabel,
  type StoredSession,
  sessionActionConfirmation,
} from "@omp-app/protocol";
import { useEffect, useMemo, useState } from "react";
import type { EnginePhase } from "../composer-state";
import { requestFollow } from "../follow-request";
import { sessionTitle } from "../format";
import { replicas } from "../session-hooks";
import { CLEAR_BLOCKED, DELETE_BLOCKED, sessionMenuState } from "../session-menu";
import { type Action, type Asked, CommandPalette } from "./CommandPalette";
import {
  type ActionId,
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
  /** Copies the focused session. */
  readonly onFork: (id: string) => void;
  /** Already confirmed in the palette. */
  readonly onClearContext: (id: string) => void;
  /** Already confirmed in the palette; the host moves the focus once the session is gone. */
  readonly onDelete: (id: string) => void;
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
  const refs = useMemo(
    () => sessionRefs(props.stored, props.openCwds, titles, sessionId),
    [props.stored, props.openCwds, titles, sessionId],
  );
  // Whether every agent is paused is the sidecar's word, read when the palette opens. Until it
  // answers, the row is not offered: a label guessed from nothing could pause when it says resume.
  const [paused, setPaused] = useState<boolean | null>(null);
  useEffect(() => {
    if (blocked !== null) return;
    let live = true;
    window.omp.agents.pauseState().then(
      (state) => live && setPaused(state.paused),
      () => live && setPaused(null),
    );
    return () => {
      live = false;
    };
  }, [blocked]);

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
    if (sessionId && blocked === null) {
      const state = replicas.store.getState().sessions[sessionId];
      const menu = sessionMenuState({
        open: true,
        readOnly,
        status: state?.status,
        waiting: (state?.pending.length ?? 0) > 0,
        onDisk: props.stored?.some((stored) => stored.id === sessionId) ?? false,
      });
      // Fork copies the session as it is on disk, and omp refuses while a turn runs.
      if (menu.clear.state !== "hidden" && state?.status !== "streaming") {
        actions.push({ id: "fork-session", label: "Fork session", scope: "session" });
      }
      if (menu.clear.state !== "hidden") {
        actions.push({ id: "clear-context", label: "Clear context", scope: "session", asks: true });
        actions.push({
          id: "delete-session",
          label: "Delete session",
          scope: "session",
          asks: true,
        });
      }
      if (paused !== null) {
        actions.push({
          id: "toggle-pause",
          label: pauseLabel(paused),
          ...(paused ? {} : { asks: true as const }),
        });
      }
    }
    return {
      sessions: refs,
      actions,
      commands: blocked ? { state: "unavailable", why: blocked } : fetched,
      canPrompt: sessionId !== null && blocked === null,
      focusedTitle: sessionId ? (titles.get(sessionId) ?? null) : null,
    };
  }, [props, titles, refs, sessionId, blocked, fetched, paused, readOnly]);

  /** The question of an action that asks first, or why it cannot run now (shown as a sentence). */
  const prepare = async (id: ActionId): Promise<Asked> => {
    if (id === "toggle-pause") return pauseConfirmation();
    if (sessionId === null) throw new Error("sidecar is not ready");
    const title = refs.find((ref) => ref.id === sessionId)?.title ?? "this session";
    const state = replicas.store.getState().sessions[sessionId];
    const streaming = state?.status === "streaming";
    if (id === "clear-context") {
      if (streaming) throw new Error(CLEAR_BLOCKED);
      return sessionActionConfirmation("clear", { title });
    }
    const waiting = (state?.pending.length ?? 0) > 0;
    if (streaming && !waiting) throw new Error(DELETE_BLOCKED);
    const { subagents } = await window.omp.session.deletePreview(sessionId);
    return sessionActionConfirmation("delete", { title, subagents, waiting });
  };

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
          case "fork-session":
            if (sessionId === null) return;
            props.onClose();
            props.onFork(sessionId);
            return;
          case "clear-context":
            // Only reached from the confirmation, which `prepare` worded.
            if (sessionId === null || action.confirmed !== true) return;
            props.onClose();
            props.onClearContext(sessionId);
            return;
          case "delete-session":
            if (sessionId === null || action.confirmed !== true) return;
            props.onClose(false);
            props.onDelete(sessionId);
            return;
          case "toggle-pause": {
            if (sessionId === null || paused === null) return;
            // A rejection stays in the palette. The sidecar writes the outcome as a line in this
            // session's timeline, so the person sees it without the palette.
            await window.omp.agents.setPaused(
              sessionId,
              !paused,
              paused ? undefined : action.confirmed,
            );
            props.onShowSession();
            requestFollow(sessionId);
            props.onClose();
            return;
          }
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

  return (
    <CommandPalette
      input={input}
      onDismiss={() => props.onClose()}
      onAction={carryOut}
      onPrepare={prepare}
    />
  );
}
