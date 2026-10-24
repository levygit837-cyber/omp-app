/** Keeps the last `capacity` complete lines of a text stream, tolerating chunks that split lines. */
export class LogTail {
  readonly #capacity: number;
  readonly #lines: string[] = [];
  #partial = "";

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  push(chunk: string): void {
    const parts = (this.#partial + chunk).split("\n");
    this.#partial = parts.pop() ?? "";
    for (const part of parts) this.#add(part);
  }

  /** The retained lines, oldest first, plus any unterminated line still being written. */
  lines(): string[] {
    return this.#partial ? [...this.#lines, this.#partial] : [...this.#lines];
  }

  clear(): void {
    this.#lines.length = 0;
    this.#partial = "";
  }

  #add(line: string): void {
    this.#lines.push(line.replace(/\r$/, ""));
    if (this.#lines.length > this.#capacity) this.#lines.shift();
  }
}
