// SQLite DatabaseService (plan.md §9) as an Effect layer over a pluggable
// backend: the Fiddle engine worker in the browser (sqlite-browser.ts),
// node:sqlite natively (native-sqlite.ts) and @sqlite.org/sqlite-wasm memory
// under Deno (sqlite-wasm.ts). One implementation of the rules for all three:
//
// - scoped acquisition: the backend (worker, module) and its connection are
//   acquired with acquireRelease; closing the scope closes both;
// - execute, tables, schema, export, reset and import share one permit, so
//   they never interleave;
// - reset and import close the current connection before opening the next
//   and swap it in a Ref, so the service object never changes;
// - a write (changes > 0 || schemaChanged) publishes exactly one change
//   event after it succeeded; a failing script publishes one only when an
//   earlier statement already changed something (§9);
// - raw cells are normalized once, here, by sqlite-cells.ts.
import {
  Context,
  Data,
  Effect,
  Layer,
  PubSub,
  Ref,
  type Scope,
  Semaphore,
  Stream,
} from "effect";
import type {
  DatabaseChange,
  DatabaseService,
  QueryResult,
} from "../core/types.ts";
import { normalizeResult, type RawQueryResult } from "./sqlite-cells.ts";

export type DatabaseOperation =
  import("../core/types.ts").DatabaseError["operation"];

/** The §9 `DatabaseError`, as a tagged class so `Effect.catchTag` works. */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: DatabaseOperation;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Service key shared by every DatabaseService implementation. */
export class Database extends Context.Service<Database, DatabaseService>()(
  "prototyper/Database",
) {}

/** Thrown by a connection when a script fails after partly applying. */
export class SqliteExecFailure extends Error {
  constructor(
    message: string,
    readonly partial: {
      readonly changes: number;
      readonly schemaChanged: boolean;
    },
    readonly detail: unknown = null,
  ) {
    super(message);
    this.name = "SqliteExecFailure";
  }
}

/** One open database. Methods may be sync or async and may throw. */
export interface SqliteConnection {
  /** Runs every statement; columns/rows from the first result set. */
  execute(
    sql: string,
    maxRows: number,
  ): RawQueryResult | Promise<RawQueryResult>;
  tables(): readonly string[] | Promise<readonly string[]>;
  /** CREATE statement of `table`; throws when it does not exist. */
  schema(table: string): string | Promise<string>;
  exportBytes(): Uint8Array | Promise<Uint8Array>;
  close(): void | Promise<void>;
}

/** An engine instance that hands out connections to one database. */
export interface SqliteBackend {
  readonly version: string;
  readonly persistence: DatabaseService["persistence"];
  readonly capabilities: DatabaseService["capabilities"];
  /**
   * fresh: start empty (wipes persisted storage); bytes: open a copy of an
   * exported image, validated before it replaces anything.
   */
  open(
    options: { fresh: boolean; bytes?: Uint8Array },
  ): Promise<SqliteConnection>;
  /** Writes made outside this service (the shell); optional. */
  onExternalChange?(listener: (change: DatabaseChange) => void): () => void;
}

export type SqliteServiceOptions = {
  /** Scoped: its finalizer releases the engine (e.g. terminates the worker). */
  readonly backend: Effect.Effect<SqliteBackend, DatabaseError, Scope.Scope>;
  /** Applied with `seed` once per database (PRAGMA user_version marks it). */
  readonly schema: string;
  readonly seed: string;
  readonly maxRows?: number;
};

export const DEFAULT_MAX_ROWS = 1000;

const describe = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
};

export const toDatabaseError =
  (operation: DatabaseOperation) => (cause: unknown): DatabaseError =>
    cause instanceof DatabaseError ? cause : new DatabaseError({
      operation,
      message: describe(cause),
      cause,
    });

const call = <A>(operation: DatabaseOperation, f: () => A | Promise<A>) =>
  Effect.tryPromise({
    try: async () => await f(),
    catch: toDatabaseError(operation),
  });

const SQLITE_HEADER = "SQLite format 3\0";
export const isSqliteImage = (bytes: Uint8Array): boolean =>
  bytes.length >= 512 &&
  String.fromCharCode(...bytes.subarray(0, 16)) === SQLITE_HEADER;

const partialOf = (cause: unknown) =>
  cause instanceof SqliteExecFailure ? cause.partial : undefined;

const isWrite = (r: { changes: number; schemaChanged: boolean }) =>
  r.changes > 0 || r.schemaChanged;

/** Schema + seed once per database; rolls back if any statement fails. */
const initialize = (
  conn: SqliteConnection,
  opts: SqliteServiceOptions,
  operation: DatabaseOperation,
) =>
  call(operation, async () => {
    const v = await conn.execute("PRAGMA user_version", 1);
    if (Number(v.rows[0]?.[0]) !== 0) return;
    try {
      await conn.execute(
        `BEGIN;\n${opts.schema};\n${opts.seed};\nPRAGMA user_version = 1;\nCOMMIT;`,
        0,
      );
    } catch (e) {
      try {
        await conn.execute("ROLLBACK", 0);
      } catch { /* no transaction left open */ }
      throw e;
    }
  });

/** quick_check on the live image after an import (defense in depth). */
const verifyImage = (conn: SqliteConnection) =>
  call("import", async () => {
    const r = await conn.execute("PRAGMA quick_check", 10);
    if (r.rows[0]?.[0] !== "ok") {
      throw new Error(
        `imported image failed quick_check: ${String(r.rows[0]?.[0])}`,
      );
    }
  });

export const make = (
  opts: SqliteServiceOptions,
): Effect.Effect<DatabaseService, DatabaseError, Scope.Scope> =>
  Effect.gen(function* () {
    const maxRowsDefault = opts.maxRows ?? DEFAULT_MAX_ROWS;
    const lock = yield* Semaphore.make(1);
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<DatabaseChange>(),
      PubSub.shutdown,
    );
    const backend = yield* opts.backend;
    if (backend.onExternalChange) {
      const listen = backend.onExternalChange;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          listen((change) => {
            PubSub.publishUnsafe(pubsub, change);
          })
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
    }
    // The service object never changes; only the connection in this Ref.
    const current = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const conn = yield* call("open", () => backend.open({ fresh: false }));
        yield* initialize(conn, opts, "open").pipe(
          Effect.tapError(() =>
            call("open", () => conn.close()).pipe(Effect.ignore)
          ),
        );
        return yield* Ref.make<SqliteConnection | undefined>(conn);
      }),
      (ref) =>
        Effect.gen(function* () {
          const conn = yield* Ref.getAndSet(ref, undefined);
          if (conn) yield* call("open", () => conn.close()).pipe(Effect.ignore);
        }),
    );

    const withConnection = <A>(
      operation: DatabaseOperation,
      f: (conn: SqliteConnection) => A | Promise<A>,
    ) =>
      Effect.gen(function* () {
        const conn = yield* Ref.get(current);
        if (!conn) {
          return yield* new DatabaseError({
            operation,
            message: "database is closed",
            cause: null,
          });
        }
        return yield* call(operation, () => f(conn));
      });

    const publish = (change: DatabaseChange) => PubSub.publish(pubsub, change);

    const execute: DatabaseService["execute"] = (sql, options) => {
      const source = options?.source ?? "app";
      return withConnection(
        "execute",
        (conn) => conn.execute(sql, options?.maxRows ?? maxRowsDefault),
      ).pipe(
        Effect.map(normalizeResult),
        Effect.tap((r) =>
          isWrite(r)
            ? publish({
              kind: "write",
              source,
              changes: r.changes,
              schemaChanged: r.schemaChanged,
            })
            : Effect.void
        ),
        Effect.tapError((e) => {
          const partial = partialOf(e.cause);
          return partial && isWrite(partial)
            ? publish({ kind: "write", source, ...partial })
            : Effect.void;
        }),
        lock.withPermit,
      );
    };

    /** Close, open the replacement, verify/seed, store, publish. */
    const swap = (
      operation: "reset" | "import",
      bytes: Uint8Array | undefined,
    ) =>
      Effect.gen(function* () {
        const old = yield* Ref.get(current);
        // Snapshot first so a failed import can restore the previous data.
        const snapshot = bytes && old
          ? yield* call(operation, () => old.exportBytes())
          : undefined;
        // Close before open: opfs-sahpool cannot hold two handles on a file.
        yield* Ref.set(current, undefined);
        if (old) yield* call(operation, () => old.close());
        const opened = yield* call(
          operation,
          () => backend.open({ fresh: true, bytes }),
        ).pipe(
          Effect.tap((conn) =>
            (bytes ? verifyImage(conn) : initialize(conn, opts, operation))
              .pipe(
                Effect.tapError(() =>
                  call(operation, () => conn.close()).pipe(Effect.ignore)
                ),
              )
          ),
          Effect.exit,
        );
        if (opened._tag === "Success") {
          yield* Ref.set(current, opened.value);
          yield* publish({
            kind: operation,
            source: "host",
            changes: 0,
            schemaChanged: true,
          });
          return;
        }
        // Recover (snapshot, else fresh seeds) so the prototype stays usable,
        // then report the original failure.
        const fallback = yield* call(
          "recover",
          () => backend.open({ fresh: true, bytes: snapshot }),
        );
        if (!snapshot) yield* initialize(fallback, opts, "recover");
        yield* Ref.set(current, fallback);
        if (!snapshot) {
          yield* publish({
            kind: "reset",
            source: "host",
            changes: 0,
            schemaChanged: true,
          });
        }
        return yield* opened;
      }).pipe(lock.withPermit);

    const service: DatabaseService = {
      engine: "sqlite",
      version: backend.version,
      persistence: backend.persistence,
      capabilities: backend.capabilities,
      execute,
      tables: () =>
        withConnection("tables", (conn) => conn.tables()).pipe(lock.withPermit),
      schema: (table) =>
        withConnection("schema", (conn) => conn.schema(table)).pipe(
          lock.withPermit,
        ),
      reset: () => swap("reset", undefined),
      exportBytes: () =>
        withConnection("export", (conn) => conn.exportBytes()).pipe(
          lock.withPermit,
        ),
      importBytes: (bytes) =>
        isSqliteImage(bytes) ? swap("import", bytes) : Effect.fail(
          new DatabaseError({
            operation: "import",
            message: "not an SQLite database image (bad header)",
            cause: null,
          }),
        ),
      subscribe: PubSub.subscribe(pubsub),
      changes: Stream.fromPubSub(pubsub),
    };
    return service;
  });

/** Scoped layer: the finalizer closes the connection and the backend. */
export const layer = (
  opts: SqliteServiceOptions,
): Layer.Layer<Database, DatabaseError> => Layer.effect(Database)(make(opts));

// ---------------------------------------------------------------------------
// Helpers shared by the in-process connections (node:sqlite, sqlite-wasm).
// ---------------------------------------------------------------------------

export const TABLES_SQL =
  "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

/** Single-quoted SQL string literal (schema() lookups, ATTACH paths). */
export const sqlString = (s: string): string => `'${s.replaceAll("'", "''")}'`;

export type { QueryResult };
