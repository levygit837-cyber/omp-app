export interface DiffLine {
  kind: "add" | "remove" | "context" | "skip";
  oldLine?: number;
  newLine?: number;
  /** Line content without the diff prefix. For `skip`, a short label such as `… 14 lines above`. */
  text: string;
}

export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "remove") removed++;
  }
  return { added, removed };
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a standard unified diff. File headers (`diff --git`, `index`, `---`, `+++`) are ignored.
 * Hunk counts decide where a hunk ends, so a removed line such as `-- x` is not mistaken for a
 * header. Omitted counts default to 1. Gaps between hunks become `skip` lines.
 */
export function parseUnifiedDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  let nextNew = 1; // first new-file line not yet covered by a hunk
  let seenHunk = false;

  for (const line of text.split(/\r?\n/)) {
    const header = HUNK.exec(line);
    if (header && (oldLeft + newLeft === 0 || line.startsWith("@@ -"))) {
      oldNo = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newNo = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      const gap = (newLeft === 0 ? newNo + 1 : newNo) - nextNew;
      if (gap > 0)
        out.push({ kind: "skip", text: seenHunk ? `… ${gap} lines` : `… ${gap} lines above` });
      seenHunk = true;
      continue;
    }
    if (oldLeft + newLeft === 0) continue; // outside a hunk
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const sign = line[0];
    const body = line.slice(1);
    if (sign === "+") {
      out.push({ kind: "add", newLine: newNo++, text: body });
      newLeft--;
    } else if (sign === "-") {
      out.push({ kind: "remove", oldLine: oldNo++, text: body });
      oldLeft--;
    } else if (sign === " " || line === "") {
      out.push({ kind: "context", oldLine: oldNo++, newLine: newNo++, text: body });
      oldLeft--;
      newLeft--;
    } else {
      oldLeft = 0;
      newLeft = 0;
      continue;
    }
    oldLeft = Math.max(oldLeft, 0);
    newLeft = Math.max(newLeft, 0);
    nextNew = newNo;
  }
  return out;
}
