// Promise wrappers for the DB0-local shell ops (sqlite-shell-protocol.ts) on
// top of R0's EngineWorkerClient. The client forwards every worker message to
// subscribers, so the extension needs no change to worker-client.ts: requests
// go through `client.shell()` and replies are matched by id here.
import type { Cell, DatabaseError } from "../core/types.ts";
import type { EngineWorkerClient, ShellRequest } from "./worker-client.ts";
import {
  CONTINUATION_PROMPT,
  isSqliteShellOpEvent,
  type SqliteShellExportValue,
  type SqliteShellHandleValue,
  type SqliteShellOpRequest,
  type SqliteShellQueryValue,
} from "./sqlite-shell-protocol.ts";

export { CONTINUATION_PROMPT };

let nextId = 1;

const request = <V>(
  client: EngineWorkerClient,
  build: (id: number) => SqliteShellOpRequest,
): Promise<V> =>
  new Promise<V>((resolve, reject) => {
    const id = nextId++;
    const unsubscribe = client.subscribe((event) => {
      const message: unknown = event; // replies are outside the frozen union
      if (!isSqliteShellOpEvent(message) || message.id !== id) return;
      unsubscribe();
      if (message.ok) resolve(message.value as V);
      else reject(message.error satisfies DatabaseError);
    });
    client.shell(build(id) as unknown as ShellRequest);
  });

export interface ShellQueryOptions {
  readonly params?: readonly Cell[];
  readonly maxRows?: number;
}

/** Structured query on the shell's own sqlite3* (raw exports in the worker). */
export const shellQuery = (
  client: EngineWorkerClient,
  sql: string,
  options: ShellQueryOptions = {},
): Promise<SqliteShellQueryValue> =>
  request(client, (id) => ({
    family: "shell",
    op: "query",
    id,
    sql,
    params: options.params,
    maxRows: options.maxRows,
  }));

/** fiddle_reset_db(): empties the database and keeps the same handle. */
export const shellReset = (
  client: EngineWorkerClient,
): Promise<SqliteShellHandleValue> =>
  request(client, (id) => ({ family: "shell", op: "reset", id }));

/** sqlite3_js_db_export() of the live database. */
export const shellExport = (
  client: EngineWorkerClient,
): Promise<SqliteShellExportValue> =>
  request(client, (id) => ({ family: "shell", op: "export", id }));

/**
 * Validates the image on a private connection (deserialize + quick_check),
 * then copies it into the live handle with the backup API; a bad image never
 * touches the live database.
 */
export const shellImport = (
  client: EngineWorkerClient,
  bytes: Uint8Array,
): Promise<SqliteShellHandleValue> =>
  request(client, (id) => ({ family: "shell", op: "import", id, bytes }));

/** One typed line (or a complete unit) for the upstream shell. */
export const shellSubmit = (client: EngineWorkerClient, text: string): void =>
  client.shell({ family: "shell", op: "submit", text });
