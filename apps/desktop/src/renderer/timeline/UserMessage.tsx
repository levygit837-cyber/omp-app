import type { UserItem } from "@omp-app/protocol";
import { AttachIcon, Chip, FileIcon } from "@omp-app/ui";
import { formatBytes } from "../prompt-input";

/**
 * The person's message: the band of the design, right-aligned, no avatar and no label. A message
 * sent while the agent was answering carries a `steered` badge (BRIEF, "Mensagem do usuário"); the
 * images it carried and the files omp read for its `@` references show as chips under the text.
 */
export function UserMessage({ item }: { item: UserItem }) {
  // The files omp read for this message, not the `@` tokens in its text: a reference typed into a
  // message that joined a running turn is never read, so it gets no chip.
  const files = item.files ?? [];
  const images = item.attachments ?? [];
  return (
    <div className="flex flex-col items-end gap-(--space-6)">
      <div className="flex max-w-(--layout-user-band-max) flex-col gap-(--space-8) rounded-sm bg-bg-user px-(--space-user-band-x) py-(--space-user-band-y)">
        <p className="text-size-body leading-(--line-height-prose) break-words whitespace-pre-wrap">
          {item.text}
        </p>
        {(files.length > 0 || images.length > 0) && (
          <ul aria-label="Attachments" className="flex flex-wrap justify-end gap-(--space-6)">
            {files.map((path) => (
              <li key={`file:${path}`}>
                <Chip icon={<FileIcon />}>{path}</Chip>
              </li>
            ))}
            {images.map((image, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: attachments never reorder
              <li key={`image:${index}`}>
                <Chip
                  icon={<AttachIcon />}
                >{`${image.mimeType} · ${formatBytes(image.bytes)}`}</Chip>
              </li>
            ))}
          </ul>
        )}
      </div>
      {item.steered && (
        <span className="rounded-sm border border-border-default px-(--space-6) py-(--space-2) font-mono text-size-2xs tracking-caps text-text-dim uppercase">
          steered
        </span>
      )}
    </div>
  );
}
