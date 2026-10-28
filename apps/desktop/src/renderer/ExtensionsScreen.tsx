import type { SettingScope } from "@omp-app/protocol";
import { Button, cx, IconButton, SearchIcon, SidebarLeftExpandIcon, StatusPill } from "@omp-app/ui";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { filterServers, filterSkills, READ_ONLY_NOTE_ID } from "./extensions-model";
import { type Loadable, useMcp, useSkills } from "./extensions-state";
import { projectName } from "./format";
import { McpServers } from "./McpServers";
import { Shortcut } from "./Shortcut";
import { SkillsList } from "./SkillsList";
import { useCwd } from "./session-hooks";
import { shortPath } from "./settings-model";

type Tab = "servers" | "skills";

/**
 * MCP servers are read when a session starts, so an open session keeps its tools. Skills differ:
 * omp re-reads them for an open session when its settings change (`sdk.ts:5153` [V]), so the
 * line for skills does not promise that an open session stays as it is.
 */
const NOTE: Record<Tab, string> = {
  servers: "Applies to new sessions. This session keeps its current tools.",
  skills:
    "Applies to new sessions. An open session may pick it up the next time its settings change.",
};

function Status({ state, retry }: { state: Loadable<unknown>; retry: () => void }) {
  if (state.status === "loading") {
    return (
      <p role="status" className="py-(--space-12) text-size-md text-text-secondary">
        Reading…
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <div role="alert" className="flex flex-col items-start gap-(--space-12) py-(--space-12)">
        <p data-testid="extensions-error" className="text-size-md text-text-primary">
          Couldn’t read this. {state.message}
        </p>
        <Button onClick={retry}>Try again</Button>
      </div>
    );
  }
  return null;
}

function ScopeSwitch({
  scope,
  project,
  onChange,
}: {
  scope: SettingScope;
  project: string;
  onChange: (scope: SettingScope) => void;
}) {
  const options: ReadonlyArray<readonly [SettingScope, string]> = [
    ["global", "Global"],
    ["project", `Project · ${project}`],
  ];
  return (
    <fieldset className="app-no-drag flex items-center gap-(--space-2) rounded-md border border-border-hairline p-(--space-2)">
      <legend className="sr-only">Servers scope</legend>
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={scope === id}
          onClick={() => onChange(id)}
          className={cx(
            "rounded-sm px-(--space-12) py-(--space-6) text-size-sm",
            scope === id
              ? "bg-bg-selected text-text-primary"
              : "text-text-secondary hover:text-text-primary",
          )}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

function Body({
  tab,
  scope,
  sessionId,
  cwd,
  readOnly,
  query,
  say,
}: {
  tab: Tab;
  scope: SettingScope;
  sessionId: string | undefined;
  cwd: string | undefined;
  readOnly: boolean;
  query: string;
  say: (text: string) => void;
}) {
  const [mcp, mcpActions] = useMcp(scope, sessionId);
  const [skills, skillsActions] = useSkills(sessionId);
  const servers = useMemo(
    () => (mcp.status === "ready" ? filterServers(mcp.value.servers, query) : []),
    [mcp, query],
  );
  const visibleSkills = useMemo(
    () => (skills.status === "ready" ? filterSkills(skills.value.skills, query) : []),
    [skills, query],
  );

  if (tab === "servers") {
    if (mcp.status !== "ready") return <Status state={mcp} retry={mcpActions.reload} />;
    return (
      <McpServers
        listing={mcp.value}
        actions={mcpActions}
        sessionId={sessionId}
        projectName={cwd ? projectName(cwd) : null}
        locked={readOnly}
        query={query}
        visible={servers}
        say={say}
      />
    );
  }
  if (skills.status !== "ready") return <Status state={skills} retry={skillsActions.reload} />;
  return (
    <SkillsList
      listing={skills.value}
      visible={visibleSkills}
      actions={skillsActions}
      locked={readOnly}
      query={query}
      say={say}
    />
  );
}

/**
 * MCP servers and skills (Pen f1ZYh8). Servers are the `mcp.json` of the chosen scope; skills are
 * what omp finds for the open project. Both are read when a session starts, so nothing here
 * changes the session that is open: the note says so.
 */
export function ExtensionsScreen({
  sidecar,
  sessionId,
  sidebarOpen,
  toggleRef,
  onToggleSidebar,
  onClose,
}: {
  sidecar: SidecarStatus;
  sessionId: string | null;
  sidebarOpen: boolean;
  toggleRef: Ref<HTMLButtonElement>;
  onToggleSidebar: () => void;
  onClose: () => void;
}) {
  const cwd = useCwd(sessionId ?? "");
  const [tab, setTab] = useState<Tab>("servers");
  const [scope, setScope] = useState<SettingScope>(sessionId ? "project" : "global");
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const ready = sidecar.state === "ready";
  const readOnly = ready && sidecar.mode === "read_only";
  const effectiveScope: SettingScope = sessionId ? scope : "global";

  useEffect(() => heading.current?.focus(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // The session view stays mounted underneath: a key meant for another view is not ours.
      if (event.target instanceof Element && event.target.closest("[inert]")) return;
      if (event.metaKey && !event.shiftKey && !event.altKey && event.key === "f") {
        const field = search.current;
        if (field === null || document.activeElement === field) return;
        event.preventDefault();
        field.focus();
        field.select();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // An open form or confirmation owns Esc. If focus is elsewhere, Esc does not leave the screen
      // from under it.
      if (document.querySelector("[data-escape-owner]") !== null) return;
      const target = event.target;
      if (target === search.current) {
        if (query !== "") {
          event.preventDefault();
          setQuery("");
        }
        return;
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
        return;
      if (query !== "") setQuery("");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, query]);

  const tabs: ReadonlyArray<readonly [Tab, string]> = [
    ["servers", "Servers"],
    ["skills", "Skills"],
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="extensions-screen">
      <div
        className={cx(
          "app-drag flex h-(--layout-bar-height) shrink-0 items-center gap-(--space-16) border-b border-border-hairline pr-(--space-20)",
          sidebarOpen ? "pl-(--space-24)" : "pl-0",
        )}
      >
        {!sidebarOpen && (
          <div className="flex items-center pl-(--layout-traffic-lights)">
            <IconButton
              ref={toggleRef}
              className="app-no-drag"
              aria-label="Show sidebar"
              aria-expanded={false}
              onClick={onToggleSidebar}
            >
              <SidebarLeftExpandIcon />
            </IconButton>
          </div>
        )}
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-size-md font-medium text-text-primary outline-none"
        >
          MCP &amp; skills
        </h1>
        <span className="flex-1" />
        {ready && (
          <label className="app-no-drag relative flex h-(--size-control) w-(--layout-settings-search) items-center">
            <SearchIcon className="absolute left-(--space-10) text-icon-neutral" />
            <input
              ref={search}
              type="search"
              value={query}
              placeholder="Filter servers and skills"
              aria-label="Filter servers and skills"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              className="size-full rounded-sm border border-border-field bg-bg-base pr-(--space-30) pl-(--space-30) text-size-sm text-text-primary placeholder:text-text-dim"
            />
            <Shortcut className="pointer-events-none absolute right-(--space-10) font-mono text-text-dim">
              ⌘F
            </Shortcut>
          </label>
        )}
        {sessionId && cwd && ready && tab === "servers" && (
          <ScopeSwitch scope={effectiveScope} project={projectName(cwd)} onChange={setScope} />
        )}
        <Button variant="ghost" className="app-no-drag" onClick={onClose}>
          Back to session
        </Button>
      </div>

      {ready ? (
        <div className="flex min-h-0 flex-1 flex-col px-(--space-24)">
          <div className="flex items-end justify-between gap-(--space-16) border-b border-border-hairline pt-(--space-16)">
            <div role="tablist" aria-label="MCP and skills" className="flex gap-(--space-24)">
              {tabs.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`ext-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls="ext-panel"
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => setTab(id)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                    event.preventDefault();
                    const next = id === "servers" ? "skills" : "servers";
                    setTab(next);
                    document.getElementById(`ext-tab-${next}`)?.focus();
                  }}
                  className={cx(
                    "-mb-px border-b-2 pb-(--space-10) text-size-md",
                    tab === id
                      ? "border-text-primary text-text-primary"
                      : "border-transparent text-text-secondary hover:text-text-primary",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="pb-(--space-10) font-mono text-size-2xs text-text-dim">
              {tab === "servers"
                ? "~/.omp/agent/mcp.json + .omp/mcp.json"
                : "~/.omp/agent/skills + .omp/skills"}
            </p>
          </div>

          <p
            data-testid="extensions-note"
            className="flex items-center gap-(--space-10) pt-(--space-12) text-size-sm text-text-secondary"
          >
            {NOTE[tab]}
          </p>
          {readOnly && (
            <section
              id={READ_ONLY_NOTE_ID}
              aria-label="Read-only mode"
              data-testid="extensions-read-only"
              className="mt-(--space-12) flex flex-col gap-(--space-6) border-y border-state-approval-rule py-(--space-12)"
            >
              <p className="flex items-center gap-(--space-10) text-size-md text-text-primary">
                <StatusPill>Read-only</StatusPill>
                ~/.omp was written by an omp this app does not know yet
              </p>
              <p className="text-size-sm text-text-secondary">
                You can read servers and skills here, and every change is refused. The omp CLI can
                still edit {shortPath("~/.omp/agent/mcp.json")}.
              </p>
            </section>
          )}

          <div
            id="ext-panel"
            role="tabpanel"
            aria-labelledby={`ext-tab-${tab}`}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-(--space-20) pb-(--space-24)"
          >
            <Body
              tab={tab}
              scope={effectiveScope}
              sessionId={sessionId ?? undefined}
              cwd={cwd}
              readOnly={readOnly}
              query={query}
              say={setAnnouncement}
            />
          </div>
        </div>
      ) : (
        <p
          role="status"
          className="px-(--space-24) py-(--space-24) text-size-md text-text-secondary"
        >
          {sidecar.state === "starting"
            ? "omp is starting. Servers and skills load when it is ready."
            : "omp isn’t running. Restart it to read servers and skills."}
        </p>
      )}
      <p
        data-testid="extensions-announcer"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>
    </div>
  );
}
