import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { SCHEMA_VERSION } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import type { SchemaMismatch } from "@omp-app/protocol";

export type GuardResult =
  | { readonly mode: "normal" }
  | { readonly mode: "read_only"; readonly schema: SchemaMismatch };

/** The agent database exists but cannot be read (corrupt, not SQLite, permissions). */
export class AgentDbUnreadableError extends Error {
  constructor(dbPath: string, cause: unknown) {
    super(
      `cannot read agent database ${dbPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "AgentDbUnreadableError";
  }
}

/**
 * Reads the schema version the shared agent database was last migrated to, without opening it
 * for writing. A missing file, a missing `schema_version` table or an empty table is `null`:
 * omp will create or migrate that database itself, which is never a downgrade.
 */
export function readOnDiskSchemaVersion(dbPath: string): number | null {
  if (!existsSync(dbPath)) return null;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    throw new AgentDbUnreadableError(dbPath, error);
  }
  try {
    const row = db.query("SELECT MAX(version) AS version FROM schema_version").get() as {
      version: number | null;
    } | null;
    return typeof row?.version === "number" ? row.version : null;
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return null;
    throw new AgentDbUnreadableError(dbPath, error);
  } finally {
    db.close();
  }
}

/**
 * Must run before anything in omp opens the agent database: omp only logs a warning for a newer
 * schema and then writes to it. The check runs once, at startup: a CLI upgrading the database
 * while the sidecar is running is not detected until the next launch. The path and expected version come from the pinned omp itself.
 */
export function checkSchema(dbPath: string = getAgentDbPath()): GuardResult {
  const onDisk = readOnDiskSchemaVersion(dbPath);
  if (onDisk !== null && onDisk > SCHEMA_VERSION) {
    return { mode: "read_only", schema: { onDisk, expected: SCHEMA_VERSION } };
  }
  return { mode: "normal" };
}
