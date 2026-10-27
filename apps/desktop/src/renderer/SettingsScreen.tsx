import type { SettingEntry, SettingScope, SettingsListing } from "@omp-app/protocol";
import { Button, cx, IconButton, SearchIcon, SidebarLeftExpandIcon, StatusPill } from "@omp-app/ui";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { projectName } from "./format";
import { SettingRow } from "./SettingRow";
import { Shortcut } from "./Shortcut";
import { useCwd } from "./session-hooks";
import {
  changedByTab,
  matchedByKeyOnly,
  type Section,
  searchEntries,
  sectionsOf,
  shortPath,
  tabCounts,
} from "./settings-model";
import { type SettingsActions, useSettings } from "./settings-state";

const READ_ONLY_NOTE = "settings-read-only-note";
const PROJECT_ERROR_NOTE = "settings-project-error-note";

/** Why the app is read-only, in words the user can paste into a bug report. */
function readOnlyDetails(sidecar: SidecarStatus): string {
  if (sidecar.state !== "ready") return "";
  const { schema } = sidecar;
  return schema
    ? `Another omp wrote agent.db with schema ${schema.onDisk}; omp-app ships omp ${sidecar.ompVersion}, which reads schema ${schema.expected}. Sidecar ${sidecar.sidecarVersion}.`
    : `omp-app ships omp ${sidecar.ompVersion} (sidecar ${sidecar.sidecarVersion}); ~/.omp was written by a newer omp.`;
}

/** Copy details and the file shortcut of the read-only banner (Pen frame hDttg). */
function ReadOnlyActions({ details }: { details: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(details).then(
      () => setCopied(true),
      () => setFailed(true),
    );
  };
  const openFile = () => {
    setFailed(false);
    window.omp.settings.openConfigFile().catch(() => setFailed(true));
  };
  return (
    <div className="flex flex-wrap items-center gap-(--space-12) pt-(--space-6)">
      <Button onClick={copy}>{copied ? "Copied" : "Copy details"}</Button>
      <Button variant="ghost" onClick={openFile}>
        Open config.yml in editor
      </Button>
      {failed && (
        <p role="alert" className="text-size-sm text-state-error">
          Couldn’t do that. The details are still in the notice above.
        </p>
      )}
    </div>
  );
}

const NAV_ITEM =
  "flex w-full items-center justify-between gap-(--space-8) rounded-sm px-(--space-10) py-(--space-8) text-left text-size-md hover:bg-bg-hover";

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
      <legend className="sr-only">Settings scope</legend>
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

function SearchField({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (next: string) => void;
  inputRef: Ref<HTMLInputElement>;
}) {
  return (
    <label className="app-no-drag relative flex h-(--size-control) w-(--layout-settings-search) items-center">
      <SearchIcon className="absolute left-(--space-10) text-icon-neutral" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder="Search settings"
        aria-label="Search settings"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className="size-full rounded-sm border border-border-field bg-bg-base pr-(--space-30) pl-(--space-30) text-size-sm text-text-primary placeholder:text-text-dim"
      />
      <Shortcut className="pointer-events-none absolute right-(--space-10) font-mono text-text-dim">
        ⌘F
      </Shortcut>
    </label>
  );
}

function SectionList({
  sections,
  listing,
  scope,
  locked,
  lockedNoteId,
  actions,
  withTab,
  tabLabels,
}: {
  sections: readonly Section[];
  listing: SettingsListing;
  scope: SettingScope;
  locked: boolean;
  lockedNoteId: string | null;
  actions: SettingsActions;
  /** Search results span tabs, so their headings say which tab a section is in. */
  withTab: boolean;
  tabLabels: Record<string, string>;
}) {
  return (
    <>
      {sections.map((section) => (
        <section
          key={`${section.tab}\u0000${section.group ?? ""}`}
          aria-label={section.group ?? tabLabels[section.tab]}
        >
          {(section.group !== null || withTab) && (
            <h3 className="pt-(--space-24) font-mono text-size-2xs tracking-caps text-text-dim uppercase">
              {[withTab ? tabLabels[section.tab] : null, section.group].filter(Boolean).join(" · ")}
            </h3>
          )}
          <ul>
            {section.entries.map((entry) => (
              <SettingRow
                key={entry.id}
                entry={entry}
                files={listing.files}
                scope={scope}
                locked={locked}
                lockedNoteId={lockedNoteId}
                actions={actions}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

interface ScreenProps {
  readonly listing: SettingsListing;
  readonly scope: SettingScope;
  readonly readOnly: boolean;
  /** Text the read-only banner copies. */
  readonly details: string;
  readonly actions: SettingsActions;
  /** Selected tab id; an id the registry does not list falls back to the first tab. */
  readonly tab: string;
  readonly onTab: (tab: string) => void;
  readonly query: string;
  readonly onClearQuery: () => void;
}

function ListingView({
  listing,
  scope,
  readOnly,
  details,
  actions,
  tab: requestedTab,
  onTab,
  query,
  onClearQuery,
}: ScreenProps) {
  const tab = listing.tabs.some((t) => t.id === requestedTab)
    ? requestedTab
    : (listing.tabs[0]?.id ?? "");
  const scroller = useRef<HTMLDivElement>(null);
  const searching = query.trim() !== "";
  const projectBroken = scope === "project" && listing.projectError !== undefined;
  const locked = readOnly || projectBroken;
  const lockedNoteId = readOnly ? READ_ONLY_NOTE : projectBroken ? PROJECT_ERROR_NOTE : null;

  const tabLabels = useMemo(
    () => Object.fromEntries(listing.tabs.map((t) => [t.id, t.label])),
    [listing.tabs],
  );
  const changed = useMemo(() => changedByTab(listing.entries, scope), [listing.entries, scope]);
  const matches = useMemo(
    () => (searching ? searchEntries(listing.entries, query) : []),
    [listing.entries, query, searching],
  );
  const matchCounts = useMemo(() => tabCounts(matches), [matches]);
  const shown: readonly SettingEntry[] = useMemo(
    () => (searching ? matches : listing.entries.filter((entry) => entry.tab === tab)),
    [searching, matches, listing.entries, tab],
  );
  const sections = useMemo(() => sectionsOf(shown), [shown]);
  const current = listing.tabs.find((t) => t.id === tab);

  // A new section or a new search starts at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on these inputs only
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [tab, searching]);

  const keyOnly = searching && matches.some((entry) => matchedByKeyOnly(entry, query));
  const file = scope === "project" ? listing.files.project : listing.files.global;

  return (
    <div className="flex min-h-0 flex-1">
      <nav
        aria-label="Settings sections"
        className="w-(--layout-settings-nav) shrink-0 overflow-y-auto border-r border-border-hairline px-(--space-8) py-(--space-16)"
      >
        <ul className="flex flex-col gap-(--space-2)">
          {listing.tabs.map((item) => {
            const count = searching ? matchCounts[item.id] : changed[item.id];
            const active = !searching && item.id === tab;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    onClearQuery();
                    onTab(item.id);
                  }}
                  className={cx(
                    NAV_ITEM,
                    active ? "bg-bg-selected text-text-primary" : "text-text-secondary",
                  )}
                >
                  <span>{item.label}</span>
                  {count !== undefined && count > 0 && (
                    <span className="font-mono text-size-2xs text-text-dim">
                      {searching ? count : `${count} changed`}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-(--layout-settings-column) flex-col px-(--space-48) pt-(--space-24) pb-(--space-64)">
          {readOnly && (
            <section
              id={READ_ONLY_NOTE}
              aria-label="Read-only mode"
              data-testid="settings-read-only"
              className="mb-(--space-24) flex flex-col gap-(--space-6) border-y border-state-approval-rule py-(--space-12)"
            >
              <p className="flex items-center gap-(--space-10) text-size-md text-text-primary">
                <StatusPill>Read-only</StatusPill>
                ~/.omp was written by an omp this app does not know yet
              </p>
              <p className="text-size-sm text-text-secondary">
                Settings stay readable here and every edit is refused. The omp CLI can still edit
                config.yml directly.
              </p>
              <ReadOnlyActions details={details} />
            </section>
          )}
          {scope === "project" && listing.projectError !== undefined && (
            <section
              id={PROJECT_ERROR_NOTE}
              role="alert"
              data-testid="settings-project-error"
              className="mb-(--space-24) flex flex-col gap-(--space-6) border-y border-state-error-border py-(--space-12)"
            >
              <p className="text-size-md text-text-primary">This project’s config cannot be read</p>
              <p className="font-mono text-size-xs break-words text-text-secondary">
                {listing.projectError}
              </p>
              <p className="text-size-sm text-text-secondary">
                Its values are left out and editing is off. The file is untouched.
              </p>
            </section>
          )}
          {searching ? (
            <>
              <h2 role="status" className="text-size-title font-medium text-text-primary">
                {matches.length === 0
                  ? `No settings match “${query.trim()}”`
                  : `${matches.length} ${matches.length === 1 ? "setting matches" : "settings match"} “${query.trim()}”`}
              </h2>
              <p className="pt-(--space-4) text-size-sm text-text-secondary">
                Searches labels, descriptions and keys in every section.{" "}
                {keyOnly && "Some results matched by key only. "}Esc clears.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-size-title font-medium text-text-primary">{current?.label}</h2>
              {current && (
                <p className="pt-(--space-4) text-size-sm text-text-secondary">{current.lead}</p>
              )}
              <p
                data-testid="settings-file"
                className="flex flex-wrap items-center gap-(--space-8) pt-(--space-4) text-size-sm text-text-secondary"
              >
                <span>
                  {locked && readOnly ? "Viewing" : "Editing"}{" "}
                  {scope === "project" ? "Project" : "Global"}
                </span>
                {file && (
                  <span className="font-mono text-size-2xs text-text-dim">{shortPath(file)}</span>
                )}
              </p>
            </>
          )}
          <SectionList
            sections={sections}
            listing={listing}
            scope={scope}
            locked={locked}
            lockedNoteId={lockedNoteId}
            actions={actions}
            withTab={searching}
            tabLabels={tabLabels}
          />
        </div>
      </div>
    </div>
  );
}

function Loaded({
  scope,
  sessionId,
  readOnly,
  details,
  tab,
  onTab,
  query,
  onClearQuery,
}: {
  scope: SettingScope;
  sessionId: string | undefined;
  readOnly: boolean;
  details: string;
  tab: string;
  onTab: (tab: string) => void;
  query: string;
  onClearQuery: () => void;
}) {
  const [state, actions] = useSettings(scope, sessionId);
  if (state.status === "loading") {
    return (
      <p role="status" className="px-(--space-24) py-(--space-24) text-size-md text-text-secondary">
        Reading settings…
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <div role="alert" className="flex flex-col items-start gap-(--space-12) p-(--space-24)">
        <p data-testid="settings-error" className="text-size-md text-text-primary">
          Couldn’t read settings. {state.message}
        </p>
        <Button onClick={actions.reload}>Try again</Button>
      </div>
    );
  }
  return (
    <ListingView
      listing={state.listing}
      scope={scope}
      readOnly={readOnly}
      details={details}
      actions={actions}
      tab={tab}
      onTab={onTab}
      query={query}
      onClearQuery={onClearQuery}
    />
  );
}

/**
 * Settings, generated from the omp registry. `sessionId` is the open session: the sidecar takes the
 * project directory from it, and without one only Global is offered.
 */
export function SettingsScreen({
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
  onClose: (() => void) | null;
}) {
  const cwd = useCwd(sessionId ?? "");
  const [scope, setScope] = useState<SettingScope>(sessionId ? "project" : "global");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const ready = sidecar.state === "ready";
  const readOnly = ready && sidecar.mode === "read_only";
  // Closing the session while in project scope (or never having one) leaves only Global.
  const effectiveScope: SettingScope = sessionId ? scope : "global";

  useEffect(() => heading.current?.focus(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && !event.shiftKey && !event.altKey && event.key === "f") {
        // Only while there is a field to jump to and the caret is not already in it.
        const field = search.current;
        if (field === null || document.activeElement === field) return;
        event.preventDefault();
        field.focus();
        field.select();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target === search.current) {
        if (query !== "") {
          event.preventDefault();
          setQuery("");
        }
        return;
      }
      // Escape inside a field reverts that field; it must not also leave the screen.
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      )
        return;
      if (query !== "") setQuery("");
      else onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="settings-screen">
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
          Settings
        </h1>
        <span className="flex-1" />
        {ready && <SearchField value={query} onChange={setQuery} inputRef={search} />}
        {sessionId && cwd && ready && (
          <ScopeSwitch scope={effectiveScope} project={projectName(cwd)} onChange={setScope} />
        )}
        {onClose && (
          <Button variant="ghost" className="app-no-drag" onClick={onClose}>
            Back to session
          </Button>
        )}
      </div>
      {ready ? (
        <Loaded
          scope={effectiveScope}
          sessionId={sessionId ?? undefined}
          readOnly={readOnly}
          details={readOnlyDetails(sidecar)}
          tab={tab}
          onTab={setTab}
          query={query}
          onClearQuery={() => setQuery("")}
        />
      ) : (
        <p
          role="status"
          className="px-(--space-24) py-(--space-24) text-size-md text-text-secondary"
        >
          {sidecar.state === "starting"
            ? "omp is starting. Settings load when it is ready."
            : "omp isn’t running. Restart it to read settings."}
        </p>
      )}
    </div>
  );
}
