// Browser SQLite backend on R0's engine worker: the exec family runs on the
// Fiddle engine's own sqlite3* (the upstream shell's database), so the
// service and the sqlite3 shell share one live database (plan.md §9,
// pocs/sqlite-shell "bridge"). Reset and import keep the shell's handle:
// reset is fiddle_reset_db, import validates a private copy and backs it up
// into the handle. Writes made by the shell arrive as worker `change` events.
import { Effect, type Scope } from "effect";
import type {
  DatabaseChange,
  DatabaseService,
  Persistence,
  QueryResult,
  WorkerEvent,
} from "../core/types.ts";
import {
  type EngineWorkerClient,
  type EngineWorkerOptions,
  type ExecOp,
  spawnEngineWorker,
} from "./worker-client.ts";
import type { RawQueryResult } from "./sqlite-cells.ts";
import {
  DatabaseError,
  type DatabaseOperation,
  layer,
  type SqliteBackend,
  type SqliteConnection,
  SqliteExecFailure,
} from "./sqlite-service.ts";

export type BrowserSqliteOptions = {
  /** Default "opfs-sahpool" (Q15); falls back to memory with a reason. */
  readonly persistence?: Persistence;
  /**
   * Use an engine worker owned by someone else (e.g. the editor host that
   * also mounts the shell). The service then never terminates it.
   */
  readonly client?: EngineWorkerClient;
  readonly worker?: EngineWorkerOptions;
  /** Start from an empty database even if storage persisted one (tests). */
  readonly fresh?: boolean;
  /** Test hooks: connection closes and worker termination. */
  readonly onClose?: () => void;
  readonly onDispose?: () => void;
};

/** Facts reported by the worker's D1 "open" op. */
export type BrowserOpenInfo = {
  readonly requested: Persistence;
  readonly actual: Persistence;
  readonly reason: string;
  readonly vfs: string | null;
  readonly filename: string;
  readonly handle: string;
  readonly version: string;
};

/** Worker failures arrive as plain §9 DatabaseError objects. */
const fromWorker = (operation: DatabaseOperation) => (e: unknown): never => {
  const err = e as { message?: string; cause?: unknown } | undefined;
  const cause = err?.cause as
    | { changes?: number; schemaChanged?: boolean }
    | null
    | undefined;
  if (operation === "execute" && typeof cause?.changes === "number") {
    throw new SqliteExecFailure(err?.message ?? String(e), {
      changes: cause.changes,
      schemaChanged: cause.schemaChanged === true,
    }, e);
  }
  throw new DatabaseError({
    operation,
    message: err?.message ?? String(e),
    cause: err?.cause ?? e,
  });
};

const raw = (r: QueryResult): RawQueryResult => r;

// "open" is a D1 extension of the exec ops; admitted by the union in types.ts (review M1).
const openOp: ExecOp = "open";

const connection = (
  client: EngineWorkerClient,
  onClose: () => void,
): SqliteConnection => {
  let open = true;
  const guard = (operation: DatabaseOperation) => {
    if (!open) {
      throw new DatabaseError({
        operation,
        message: "connection is closed",
        cause: null,
      });
    }
  };
  return {
    execute: async (sql, maxRows) => {
      guard("execute");
      return raw(await client.exec(sql, maxRows).catch(fromWorker("execute")));
    },
    tables: async () => {
      guard("tables");
      const r = await client.op("tables").catch(fromWorker("tables"));
      return r.rows.map((row) => String(row[0]));
    },
    schema: async (table) => {
      guard("schema");
      const r = await client.op("schema", table).catch(fromWorker("schema"));
      return String(r.rows[0]?.[0]);
    },
    exportBytes: async () => {
      guard("export");
      const r = await client.op("export").catch(fromWorker("export"));
      return r.rows[0]?.[0] as Uint8Array;
    },
    // The handle belongs to the shell; closing only retires this view.
    close: () => {
      if (!open) return;
      open = false;
      onClose();
    },
  };
};

const capabilities = (
  info: BrowserOpenInfo,
  crossOriginIsolated: boolean,
): DatabaseService["capabilities"] => ({
  persistence: info.actual === "memory"
    ? {
      available: false,
      reason: info.reason || "memory database (lost on reload)",
    }
    : { available: true },
  multiTab: {
    available: false,
    reason: info.actual === "opfs-sahpool"
      ? "opfs-sahpool is single-tab; opfs/opfs-wl are deferred (Q15)"
      : "memory databases are per tab",
  },
  export: { available: true },
  import: { available: true },
  cancellation: {
    available: false,
    reason: crossOriginIsolated
      ? "shell cancellation is deferred (Q15)"
      : "needs COOP/COEP (SharedArrayBuffer); deferred (Q15)",
  },
});

const acquireClient = (options: BrowserSqliteOptions) =>
  options.client ? Effect.succeed(options.client) : Effect.acquireRelease(
    Effect.sync(() => spawnEngineWorker(options.worker)),
    (client) =>
      Effect.sync(() => {
        client.terminate();
        options.onDispose?.();
      }),
  );

export const browserSqliteBackend = (
  options: BrowserSqliteOptions = {},
): Effect.Effect<SqliteBackend, DatabaseError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* acquireClient(options);
    const engine = yield* Effect.tryPromise({
      try: () => client.ready,
      catch: (e) =>
        new DatabaseError({
          operation: "open",
          message: (e as { message?: string })?.message ?? String(e),
          cause: e,
        }),
    });
    const opened = yield* Effect.tryPromise({
      try: () =>
        client.op(openOp, {
          persistence: options.persistence ?? "opfs-sahpool",
          fresh: options.fresh === true,
        }),
      catch: (e) =>
        new DatabaseError({
          operation: "open",
          message: (e as { message?: string })?.message ?? String(e),
          cause: e,
        }),
    });
    const row = opened.rows[0] ?? [];
    const info: BrowserOpenInfo = Object.fromEntries(
      opened.columns.map((c, i) => [c, row[i]]),
    ) as BrowserOpenInfo;
    const onClose = () => options.onClose?.();
    const backend: SqliteBackend & { readonly info: BrowserOpenInfo } = {
      info,
      version: info.version || engine.libversion,
      persistence: info.reason
        ? {
          requested: info.requested,
          actual: info.actual,
          reason: info.reason,
        }
        : { requested: info.requested, actual: info.actual },
      capabilities: capabilities(info, engine.crossOriginIsolated),
      open: async ({ fresh, bytes }) => {
        if (bytes) await client.op("import", bytes).catch(fromWorker("import"));
        else if (fresh) await client.op("reset").catch(fromWorker("reset"));
        return connection(client, onClose);
      },
      onExternalChange: (listener: (change: DatabaseChange) => void) =>
        client.subscribe((event: WorkerEvent) => {
          if (event.family === "change") listener(event.change);
        }),
    };
    return backend;
  });

/** Layer for the browser: one engine worker per service unless `client`. */
export const browserSqliteLayer = (
  options: BrowserSqliteOptions & {
    readonly schema: string;
    readonly seed: string;
    readonly maxRows?: number;
  },
) =>
  layer({
    backend: browserSqliteBackend(options),
    schema: options.schema,
    seed: options.seed,
    maxRows: options.maxRows,
  });
