import type { DecisionItem } from "@omp-app/protocol";
import { AskIcon, BashIcon, EditIcon, FileIcon } from "@omp-app/ui";
import type { ComponentType, SVGProps } from "react";
import { decisionParts } from "./requests-view";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** The tool classes omp reports (ACP `ToolKind`) that have an icon in the sheet. */
const TOOL_ICON: Record<string, Icon> = {
  execute: BashIcon,
  edit: EditIcon,
  delete: EditIcon,
  move: EditIcon,
};

export function toolIcon(toolKind: string | undefined): Icon {
  return (toolKind && TOOL_ICON[toolKind]) || FileIcon;
}

/**
 * What a request leaves behind once a person answered it: a plain one-line event, no band and
 * no buttons. Success is silent, so even "Allowed once" wears the neutral icon colour.
 */
export function DecisionLine({ item }: { item: DecisionItem }) {
  const parts = decisionParts(item);
  const asked = item.outcome === "answered" || item.outcome === "cancelled";
  const Icon = asked ? AskIcon : toolIcon(item.toolKind);
  return (
    <p className="flex min-h-(--size-tool-row) items-start gap-(--space-icon-phrase) text-size-md">
      <span className="flex h-(--size-tool-row) shrink-0 items-center">
        <Icon className="text-icon-neutral" />
      </span>
      {/* Inline, not flex: a long subject wraps as text and the words after it follow on. */}
      <span className="min-w-0 py-(--space-2) break-words whitespace-pre-wrap">
        <span className="text-text-primary">{parts.lead}</span>{" "}
        <span
          className={parts.mono ? "font-mono text-size-sm text-text-primary" : "text-text-primary"}
        >
          {parts.subject}
        </span>
        {parts.tail && <span className="text-text-secondary"> · {parts.tail}</span>}
        {parts.detail && (
          <>
            {" "}
            <span className="font-mono text-size-sm text-text-primary">{parts.detail}</span>
          </>
        )}
      </span>
    </p>
  );
}
