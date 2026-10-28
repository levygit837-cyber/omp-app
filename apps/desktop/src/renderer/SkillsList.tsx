import type { SkillEntry, SkillOrigin, SkillsListing } from "@omp-app/protocol";
import { StateMark, Toggle } from "@omp-app/ui";
import { useState } from "react";
import { describeSidecarText } from "./errors";
import { groupSkills, READ_ONLY_NOTE_ID, toggledSentence } from "./extensions-model";
import type { SkillsActions } from "./extensions-state";

const GROUP_LABEL: Record<SkillOrigin, string> = {
  project: "Project",
  user: "User",
  plugin: "Plugins",
};

function SkillRow({
  skill,
  locked,
  onToggle,
}: {
  skill: SkillEntry;
  locked: boolean;
  onToggle: (next: boolean) => void;
}) {
  const on = skill.state === "active";
  const reasonId = `skill-${skill.name}-reason`;
  const why = on ? undefined : skill.reason;
  const describedBy = [why ? reasonId : null, locked ? READ_ONLY_NOTE_ID : null]
    .filter(Boolean)
    .join(" ");
  return (
    <li
      data-testid="skill-row"
      className="flex items-start gap-(--space-16) border-b border-border-hairline py-(--space-10)"
    >
      <span className="w-(--layout-skill-name) shrink-0 truncate font-mono text-size-md text-text-primary">
        {skill.name}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-(--space-2)">
        <span className="text-size-sm text-text-secondary">
          {skill.description ?? "No description."}
        </span>
        <span className="font-mono text-size-2xs text-text-dim">{skill.provider}</span>
        {why && (
          <span
            id={reasonId}
            className="flex items-center gap-(--space-6) text-size-xs text-text-secondary"
          >
            {skill.state === "shadowed" && <StateMark state="idle" label="Shadowed" />}
            {why}
          </span>
        )}
      </span>
      <span className="flex items-center gap-(--space-10) pt-(--space-2)">
        {!on && <span className="font-mono text-size-2xs text-text-dim">off</span>}
        <Toggle
          checked={on}
          disabled={locked || !skill.toggleable}
          aria-label={`${skill.name} on new sessions`}
          aria-describedby={describedBy || undefined}
          onCheckedChange={onToggle}
        />
      </span>
    </li>
  );
}

export function SkillsList({
  listing,
  visible,
  actions,
  locked,
  query,
  say,
}: {
  listing: SkillsListing;
  visible: readonly SkillEntry[];
  actions: SkillsActions;
  locked: boolean;
  query: string;
  say: (text: string) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);

  if (listing.error !== undefined) {
    return (
      <section
        role="alert"
        data-testid="skills-error"
        className="flex max-w-(--layout-empty-column) flex-col gap-(--space-8)"
      >
        <p className="flex items-center gap-(--space-8) text-size-lg text-text-primary">
          <StateMark state="error" decorative />
          Skills can’t be listed
        </p>
        <p className="text-size-md text-text-secondary">{describeSidecarText(listing.error)}</p>
      </section>
    );
  }
  if (listing.skills.length === 0) {
    return (
      <section
        data-testid="skills-empty"
        className="flex max-w-(--layout-empty-column) flex-col gap-(--space-8)"
      >
        <h2 className="text-size-lg text-text-primary">No skills found</h2>
        <p className="text-size-md text-text-secondary">
          omp looks in ~/.omp/agent/skills and in .omp/skills of the open project. A folder with a
          SKILL.md in it is a skill.
        </p>
      </section>
    );
  }
  if (visible.length === 0) {
    return (
      <p role="status" className="text-size-md text-text-secondary">
        No skill matches “{query.trim()}”.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-(--space-20)">
      {groupSkills(visible).map((group) => (
        <section key={group.origin} aria-label={`${GROUP_LABEL[group.origin]} skills`}>
          <h2 className="pb-(--space-6) font-mono text-size-2xs tracking-caps text-text-dim uppercase">
            {GROUP_LABEL[group.origin]}
          </h2>
          <ul>
            {group.skills.map((skill) => (
              <SkillRow
                key={`${group.origin}:${skill.name}`}
                skill={skill}
                locked={locked}
                onToggle={(next) =>
                  void actions.setEnabled(skill.name, next).then((outcome) => {
                    setProblem(outcome.refused);
                    say(
                      outcome.refused === null
                        ? toggledSentence(skill.name, next)
                        : outcome.refused,
                    );
                  })
                }
              />
            ))}
          </ul>
        </section>
      ))}
      {problem && (
        <p role="alert" data-testid="skills-action-error" className="text-size-sm text-state-error">
          {problem}
        </p>
      )}
    </div>
  );
}
