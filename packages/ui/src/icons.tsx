import type { ComponentProps } from "react";
import { cx } from "./cx";

/** Line icons from the design sheet (`Icon/*`), drawn on a 20 unit grid and shown at 16. */
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

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 5q0-1.5 1.5-1.5h6.5q1.5 0 1.5 1.5v3.5q0 1.5-1.5 1.5h-4.25l-2.5 2v-2q-1.25 0-1.25-1.5z m11.5 2.5h1q1.5 0 1.5 1.5v3.5q0 1.5-1.25 1.5v2l-2.5-2h-4.25q-1.5 0-1.5-1.5v-0.5" />
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

export function SidebarLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 3.75h11q1.75 0 1.75 1.75v9q0 1.75-1.75 1.75h-11q-1.75 0-1.75-1.75v-9q0-1.75 1.75-1.75z m3 0v12.5m5.75-8.25l-2 2 2 2" />
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

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 16v-12m-4.75 4.5l4.75-4.75 4.75 4.75" />
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
