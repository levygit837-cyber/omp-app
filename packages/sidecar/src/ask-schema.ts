import type { AskChoice, AskContent, AskField, AskFieldType, AskValue } from "@omp-app/protocol";

/** The part of an ACP form elicitation this module reads. */
export interface FormSchema {
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[] | undefined;
}

const OTHER_SUFFIX = "__other";

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;

/** `{ const, title?, description? }` entries (omp's `ask`) or plain strings (`enum`). */
function choicesOf(list: unknown): AskChoice[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: AskChoice[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      out.push({ value: entry, label: entry });
    } else if (typeof entry === "object" && entry !== null) {
      const e = entry as Record<string, unknown>;
      const value = typeof e.const === "string" ? e.const : undefined;
      if (value === undefined) return undefined;
      const description = text(e.description);
      out.push({
        value,
        label: text(e.title) ?? value,
        ...(description ? { description } : {}),
      });
    } else {
      return undefined;
    }
  }
  return out;
}

function fieldOf(
  key: string,
  schema: Readonly<Record<string, unknown>>,
  required: boolean,
): Omit<AskField, "otherKey" | "otherLabel"> | undefined {
  const title = text(schema.title);
  const description = text(schema.description);
  const base = {
    key,
    required,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
  const withDefault = (type: AskFieldType, extra: Partial<AskField> = {}) => {
    const d = schema.default;
    const def: AskValue | undefined =
      type === "multi"
        ? Array.isArray(d) && d.every((x) => typeof x === "string")
          ? (d as string[])
          : undefined
        : type === "confirm"
          ? typeof d === "boolean"
            ? d
            : undefined
          : typeof d === "string"
            ? d
            : undefined;
    return { ...base, type, ...extra, ...(def === undefined ? {} : { default: def }) };
  };

  if (schema.type === "boolean") return withDefault("confirm");
  if (schema.type === "string") {
    const choices = choicesOf(schema.oneOf) ?? choicesOf(schema.enum);
    if (schema.oneOf !== undefined || schema.enum !== undefined) {
      return choices && choices.length > 0 ? withDefault("select", { choices }) : undefined;
    }
    return withDefault("input");
  }
  if (schema.type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    const choices = choicesOf(items?.anyOf) ?? choicesOf(items?.enum);
    return choices && choices.length > 0 ? withDefault("multi", { choices }) : undefined;
  }
  return undefined;
}

/**
 * Turns the elicitation schema into the fields the window renders. Returns `undefined` when
 * any property is something the form cannot show (a number, a nested object): the caller then
 * declines the request, because a form that silently drops a question answers a different one.
 * `<key>__other` properties are omp's "something else" free-text answer; they attach to the
 * field they belong to instead of becoming a field of their own.
 */
export function fieldsOf(schema: FormSchema): AskField[] | undefined {
  const required = new Set(schema.required ?? []);
  const fields: AskField[] = [];
  for (const [key, property] of Object.entries(schema.properties)) {
    if (key.endsWith(OTHER_SUFFIX) && key.slice(0, -OTHER_SUFFIX.length) in schema.properties)
      continue;
    const field = fieldOf(key, property, required.has(key));
    if (!field) return undefined;
    const otherKey = `${key}${OTHER_SUFFIX}`;
    const other = schema.properties[otherKey];
    if ((field.type === "select" || field.type === "multi") && other) {
      fields.push({
        ...field,
        otherKey,
        ...(text(other.title) ? { otherLabel: text(other.title) } : {}),
      });
    } else {
      fields.push(field);
    }
  }
  return fields.length > 0 ? fields : undefined;
}

const DETAIL_MAX = 80;

/**
 * The answer in words, for the line it leaves behind: choice labels, Yes/No, typed text, in
 * field order. `content` has been through {@link checkAnswer}, so every value is known.
 */
export function summarize(fields: readonly AskField[], content: AskContent): string {
  const parts: string[] = [];
  for (const field of fields) {
    const value = content[field.key];
    const other = field.otherKey ? content[field.otherKey] : undefined;
    const label = (v: string) => field.choices?.find((c) => c.value === v)?.label ?? v;
    if (typeof other === "string") parts.push(other);
    if (value === undefined) continue;
    if (typeof value === "boolean") parts.push(value ? "yes" : "no");
    else if (Array.isArray(value)) parts.push(value.map(label).join(", "));
    else parts.push(label(String(value)));
  }
  const text = parts.join(" · ");
  const points = Array.from(text);
  return points.length > DETAIL_MAX ? `${points.slice(0, DETAIL_MAX - 1).join("")}…` : text;
}

/**
 * Checks an answer against the fields it was asked for and returns the content to send.
 * Throws a plain `Error` naming the problem: a wrong answer must not reach the agent.
 */
export function checkAnswer(fields: readonly AskField[], content: AskContent): AskContent {
  const known = new Set(fields.flatMap((f) => [f.key, ...(f.otherKey ? [f.otherKey] : [])]));
  for (const key of Object.keys(content)) {
    if (!known.has(key)) throw new Error(`unknown answer field: ${key}`);
  }
  const out: Record<string, AskValue> = {};
  for (const field of fields) {
    const value = content[field.key];
    const other = field.otherKey ? content[field.otherKey] : undefined;
    if (other !== undefined && field.otherKey) {
      if (typeof other !== "string") throw new Error(`answer to ${field.otherKey} must be text`);
      if (other.trim()) out[field.otherKey] = other.trim();
    }
    const hasOther = field.otherKey !== undefined && out[field.otherKey] !== undefined;
    const values = field.choices?.map((c) => c.value) ?? [];
    switch (field.type) {
      case "select":
        if (value === undefined || value === "") {
          if (field.required && !hasOther) throw new Error(`${field.key} needs an answer`);
        } else if (typeof value !== "string" || !values.includes(value)) {
          throw new Error(`${field.key} is not one of the offered choices`);
        } else if (!hasOther) {
          out[field.key] = value;
        }
        break;
      case "multi":
        if (value === undefined) {
          if (field.required && !hasOther) throw new Error(`${field.key} needs an answer`);
        } else if (!Array.isArray(value) || !value.every((v) => values.includes(v))) {
          throw new Error(`${field.key} has a value that was not offered`);
        } else if (value.length > 0) {
          out[field.key] = value;
        } else if (field.required && !hasOther) {
          throw new Error(`${field.key} needs an answer`);
        }
        break;
      case "confirm":
        if (value === undefined) {
          if (field.required) throw new Error(`${field.key} needs an answer`);
        } else if (typeof value !== "boolean") {
          throw new Error(`${field.key} must be true or false`);
        } else {
          out[field.key] = value;
        }
        break;
      case "input":
        if (value === undefined || value === "") {
          if (field.required) throw new Error(`${field.key} needs an answer`);
        } else if (typeof value !== "string") {
          throw new Error(`${field.key} must be text`);
        } else {
          out[field.key] = value;
        }
        break;
    }
  }
  return out;
}
