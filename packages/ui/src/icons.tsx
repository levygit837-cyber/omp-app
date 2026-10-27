import type { ComponentProps } from "react";
import { cx } from "./cx";

/**
 * Line icons from the design sheet (`Icon/*` in design/omp.pen), drawn on a 20 unit grid and
 * shown at 16. One component per Pen component, named after it (`Icon/web_search` is
 * `WebSearchIcon`); the geometry is the Pen path verbatim.
 */
function Icon({ className, children, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cx("size-(--size-icon-ui) shrink-0 stroke-(length:--size-icon-stroke)", className)}
      {...props}
    >
      {children}
    </svg>
  );
}

type IconProps = Omit<ComponentProps<"svg">, "children">;

export function AskIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.75 3.75h10.5q1.5 0 1.5 1.5v6.5q0 1.5-1.5 1.5h-5.75l-3.5 3v-3h-1.25q-1.5 0-1.5-1.5v-6.5q0-1.5 1.5-1.5z m3.85 3.15q0.15-1.15 1.4-1.15 1.4 0 1.4 1.2 0 0.95-1.4 1.45v0.6m-0.3 1.9a0.3 0.3 0 1 0 0.6 0 0.3 0.3 0 1 0-0.6 0z" />
    </Icon>
  );
}

export function AstGrepIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 2.75h2q1 0 1 1v2q0 1-1 1h-2q-1 0-1-1v-2q0-1 1-1z m-5 10.5h2q1 0 1 1v2q0 1-1 1h-2q-1 0-1-1v-2q0-1 1-1z m10 0h2q1 0 1 1v2q0 1-1 1h-2q-1 0-1-1v-2q0-1 1-1z m-4-6.5v3.25m-5 0h10m-10 0v3.25m10-3.25v3.25" />
    </Icon>
  );
}

export function AttachIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 9.25l-5.5 5.5q-2.25 2.25-4.5 0-2.25-2.25 0-4.5l6.25-6.25q1.5-1.5 3 0 1.5 1.5 0 3l-6 6q-0.75 0.75-1.5 0-0.75-0.75 0-1.5l5.25-5.25" />
    </Icon>
  );
}

export function BashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.75 5.25l4.75 4.75-4.75 4.75m7 0h5.5" />
    </Icon>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3.25v10m-1.75 1.75a1.75 1.75 0 1 0 3.5 0 1.75 1.75 0 1 0-3.5 0z m8-9.25a1.75 1.75 0 1 0 3.5 0 1.75 1.75 0 1 0-3.5 0z m1.75 1.75q0 4-8 5.25" />
    </Icon>
  );
}

export function BrowserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.75 3.75h10.5q2 0 2 2v8.5q0 2-2 2h-10.5q-2 0-2-2v-8.5q0-2 2-2z m-2 3.5h14.5m-12.3-1.75a0.3 0.3 0 1 0 0.6 0 0.3 0.3 0 1 0-0.6 0z m4.05 4.25l5 2-2.25 0.75-0.75 2.25z" />
    </Icon>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 5q0-1.5 1.5-1.5h6.5q1.5 0 1.5 1.5v3.5q0 1.5-1.5 1.5h-4.25l-2.5 2v-2q-1.25 0-1.25-1.5z m11.5 2.5h1q1.5 0 1.5 1.5v3.5q0 1.5-1.25 1.5v2l-2.5-2h-4.25q-1.5 0-1.5-1.5v-0.5" />
    </Icon>
  );
}

export function CheckpointIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 17v-13.75m0 0.75h9.25l-2.5 3.5 2.5 3.5h-9.25" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 8l4 4 4-4" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 6l4 4-4 4" />
    </Icon>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 12l4-4 4 4" />
    </Icon>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 16l0.6-3.15 8.4-8.4q1.1-1.1 2.2 0l0.35 0.35q1.1 1.1 0 2.2l-8.4 8.4z m7.85-10.4l2.55 2.55m-3.4 8.1h5.75" />
    </Icon>
  );
}

export function EvalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 3.25q-2.25 0-2.25 2.25v2.25q0 2.25-2 2.25 2 0 2 2.25v2.25q0 2.25 2.25 2.25m6-13.5q2.25 0 2.25 2.25v2.25q0 2.25 2 2.25-2 0-2 2.25v2.25q0 2.25-2.25 2.25m-4.25-9.25l3.5 2.5-3.5 2.5z" />
    </Icon>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 4.5q0-1.5 1.5-1.5h5l3.5 3.5v9q0 1.5-1.5 1.5h-7q-1.5 0-1.5-1.5z m6.5-1.5v2.5q0 1 1 1h2.5" />
    </Icon>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.75 5.5q0-1.5 1.5-1.5h3.25q0.75 0 1.25 0.6l1.25 1.4h5.75q1.5 0 1.5 1.5v7.5q0 1.5-1.5 1.5h-11.5q-1.5 0-1.5-1.5z m0 3h14.5" />
    </Icon>
  );
}

export function GithubIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 3h5l4.5 4.5v5l-4.5 4.5h-5l-4.5-4.5v-5z m0.25 6.25a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 1 0-4.5 0z m2.25 2.25v5.5" />
    </Icon>
  );
}

export function GlobIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.25 16.75l4.5-13.5m4.75 3v7.5m-3.25-5.625l6.5 3.75m0-3.75l-6.5 3.75" />
    </Icon>
  );
}

export function GrepIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 4.25h9.5m-9.5 11.5h7m-5.5-8.5h11q1.5 0 1.5 1.5v2.5q0 1.5-1.5 1.5h-11q-1.5 0-1.5-1.5v-2.5q0-1.5 1.5-1.5z m0.85 2.75a0.55 0.55 0 1 0 1.1 0 0.55 0.55 0 1 0-1.1 0z m2.9 0h6" />
    </Icon>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.25 10a6.75 6.75 0 1 0 1.98-4.77m-1.98 1.27v3.5h3.5m3.25-3.25v3.25l2.25 1.5" />
    </Icon>
  );
}

export function IssueIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.25 10a6.75 6.75 0 1 0 13.5 0 6.75 6.75 0 1 0-13.5 0z m6 0a0.75 0.75 0 1 0 1.5 0 0.75 0.75 0 1 0-1.5 0z" />
    </Icon>
  );
}

export function JobIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 3.25h6q1.25 0 1.25 1.25v4.5q0 1.25-1.25 1.25h-6q-1.25 0-1.25-1.25v-4.5q0-1.25 1.25-1.25z m-4.25 11h13.5m-2.25-2.25l2.25 2.25-2.25 2.25" />
    </Icon>
  );
}

export function LspIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.25 12.5h2q1.25 0 1.25 1.25v2q0 1.25-1.25 1.25h-2q-1.25 0-1.25-1.25v-2q0-1.25 1.25-1.25z m1 0q0-7.25 5.5-7.25m-2-2l2 2-2 2m3.75-2a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 1 0-4.5 0z" />
    </Icon>
  );
}

export function McpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 2.75v3.5m5-3.5v3.5m-7.75 0h10.5v3q0 4.5-5.25 4.5-5.25 0-5.25-4.5z m5.25 7.5v3.5" />
    </Icon>
  );
}

export function McpSkillsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.75 3.75v3m3.5-3v3m-5.5 0h7.5v2.25q0 3.5-3.75 3.5-3.75 0-3.75-3.5z m3.75 5.75v4.25m7.75-14q0.5 2.25 2.75 2.75-2.25 0.5-2.75 2.75-0.5-2.25-2.75-2.75 2.25-0.5 2.75-2.75z" />
    </Icon>
  );
}

export function MemoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 10c-2-4.25-7-4.25-7 0 0 4.25 5 4.25 7 0 2-4.25 7-4.25 7 0 0 4.25-5 4.25-7 0z m-4.3 0a0.55 0.55 0 1 0 1.1 0 0.55 0.55 0 1 0-1.1 0z" />
    </Icon>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.25 10a0.75 0.75 0 1 0 1.5 0 0.75 0.75 0 1 0-1.5 0z m5 0a0.75 0.75 0 1 0 1.5 0 0.75 0.75 0 1 0-1.5 0z m5 0a0.75 0.75 0 1 0 1.5 0 0.75 0.75 0 1 0-1.5 0z" />
    </Icon>
  );
}

export function NewSessionIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 3.25h-4.25q-2 0-2 2v9.5q0 2 2 2h9.5q2 0 2-2v-4.25m-2.5-7.75v6m-3-3h6" />
    </Icon>
  );
}

export function OverviewIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.75 5.5a0.75 0.75 0 1 0 1.5 0 0.75 0.75 0 1 0-1.5 0z m4.5 0h8.5m-13 4.5a0.75 0.75 0 1 0 1.5 0 0.75 0.75 0 1 0-1.5 0z m4.5 0h8.5m-13 4.5a0.75 0.75 0 1 0 1.5 0 0.75 0.75 0 1 0-1.5 0z m4.5 0h5.5" />
    </Icon>
  );
}

export function PlanIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.75 5.25l4.5-1.75 5.5 1.75 4.5-1.75v11.5l-4.5 1.75-5.5-1.75-4.5 1.75z m4.5-1.75v11.5m5.5-9.75v11.5" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 4.5v11m-5.5-5.5h11" />
    </Icon>
  );
}

export function PullRequestIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4.75a1.75 1.75 0 1 0 3.5 0 1.75 1.75 0 1 0-3.5 0z m1.75 1.75v7m-1.75 1.75a1.75 1.75 0 1 0 3.5 0 1.75 1.75 0 1 0-3.5 0z m8.5 0a1.75 1.75 0 1 0 3.5 0 1.75 1.75 0 1 0-3.5 0z m1.75-1.75v-6q0-1.75-1.75-1.75h-3.25m1.75-1.75l-1.75 1.75 1.75 1.75" />
    </Icon>
  );
}

export function ReadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 5.75q-2.25-2.25-6.75-2v10.75q4.5-0.25 6.75 2 2.25-2.25 6.75-2v-10.75q-4.5-0.25-6.75 2z m0 0v10.75" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.25 8.75a5.5 5.5 0 1 0 11 0 5.5 5.5 0 1 0-11 0z m9.5 4l4 4" />
    </Icon>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 16v-12m-4.75 4.5l4.75-4.75 4.75 4.75" />
    </Icon>
  );
}

export function ServiceIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.75 3h10.5q1.5 0 1.5 1.5v1.5q0 1.5-1.5 1.5h-10.5q-1.5 0-1.5-1.5v-1.5q0-1.5 1.5-1.5z m0 9.5h10.5q1.5 0 1.5 1.5v1.5q0 1.5-1.5 1.5h-10.5q-1.5 0-1.5-1.5v-1.5q0-1.5 1.5-1.5z m5.25-5v5m-4.35-7.25a0.6 0.6 0 1 0 1.2 0 0.6 0.6 0 1 0-1.2 0z m0 9.5a0.6 0.6 0 1 0 1.2 0 0.6 0.6 0 1 0-1.2 0z m4.6-9.5h3.5m-3.5 9.5h3.5" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.25 6.5h6.5m5.5 0h1.5m-13.5 7h1.5m5.5 0h6.5m-7-7a2.75 2.75 0 1 0 5.5 0 2.75 2.75 0 1 0-5.5 0z m-5 7a2.75 2.75 0 1 0 5.5 0 2.75 2.75 0 1 0-5.5 0z" />
    </Icon>
  );
}

export function SidebarLeftCollapseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 3.75h11q1.75 0 1.75 1.75v9q0 1.75-1.75 1.75h-11q-1.75 0-1.75-1.75v-9q0-1.75 1.75-1.75z m3 0v12.5m5.75-8.25l-2 2 2 2" />
    </Icon>
  );
}

export function SidebarLeftExpandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 3.75h11q1.75 0 1.75 1.75v9q0 1.75-1.75 1.75h-11q-1.75 0-1.75-1.75v-9q0-1.75 1.75-1.75z m3 0v12.5m3.75-8.25l2 2-2 2" />
    </Icon>
  );
}

export function SidebarRightCollapseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 3.75h11q1.75 0 1.75 1.75v9q0 1.75-1.75 1.75h-11q-1.75 0-1.75-1.75v-9q0-1.75 1.75-1.75z m8 0v12.5m-5.75-8.25l2 2-2 2" />
    </Icon>
  );
}

export function SidebarRightExpandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 3.75h11q1.75 0 1.75 1.75v9q0 1.75-1.75 1.75h-11q-1.75 0-1.75-1.75v-9q0-1.75 1.75-1.75z m8 0v12.5m-3.75-8.25l-2 2 2 2" />
    </Icon>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 5h7q1.5 0 1.5 1.5v7q0 1.5-1.5 1.5h-7q-1.5 0-1.5-1.5v-7q0-1.5 1.5-1.5z" />
    </Icon>
  );
}

export function SubagentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 3.25v7.25q0 1.5 1.5 1.5h2.5m1.75-3.25h5q1.5 0 1.5 1.5v3.5q0 1.5-1.5 1.5h-5q-1.5 0-1.5-1.5v-3.5q0-1.5 1.5-1.5z m-7.5-5.5h3.5" />
    </Icon>
  );
}

export function TaskIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.75 10a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 1 0-4.5 0z m4.5 0c3 0 3-5.25 6.5-5.25m-6.5 5.25c3 0 3 5.25 6.5 5.25m0-10.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z m0 10.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z" />
    </Icon>
  );
}

export function ThinkingIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.25 10.75q-1 0-1-1.25 0-1.5 1.75-1.5 2 0 2 2.25 0 2.75-2.5 2.75-4 0-4-3.5 0-4.5 4.5-4.5 5 0 5 5 0 5.5-5.75 6" />
    </Icon>
  );
}

export function TodoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 5.75l1.75 1.75 3-3.25m2.75 1.75h5.5m-11.75 6h2q1 0 1 1v2q0 1-1 1h-2q-1 0-1-1v-2q0-1 1-1z m6.25 2h5.5" />
    </Icon>
  );
}

export function WaitIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.25 3.25h9.5m-9.5 13.5h9.5m-8.25-13.5q0 4.5 3.5 6.75 3.5-2.25 3.5-6.75m-7 13.5q0-4.5 3.5-6.75 3.5 2.25 3.5 6.75" />
    </Icon>
  );
}

export function WebSearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.25 9a5.75 5.75 0 1 0 11.5 0 5.75 5.75 0 1 0-11.5 0z m5.75-5.75q-2.75 5.75 0 11.5 2.75-5.75 0-11.5m-5.75 5.75h11.5m-1.5 4.25l3.5 3.5" />
    </Icon>
  );
}

export function WriteIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 17h-4q-1.5 0-1.5-1.5v-11q0-1.5 1.5-1.5h4.5l3.5 3.5v3m-3.5-6.5v2.5q0 1 1 1h2.5m0.25 5v5.5m-2.75-2.75h5.5" />
    </Icon>
  );
}
