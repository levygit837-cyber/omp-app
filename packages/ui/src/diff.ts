export interface DiffLine {
  kind: "add" | "remove" | "context" | "skip";
  oldLine?: number;
  newLine?: number;
  /** Line content without the diff prefix. For `skip`, a short label such as `… 14 lines above`. */
  text: string;
}
