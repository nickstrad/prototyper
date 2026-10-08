// Thin `DatabaseService` adapter over the upstream shell's own engine, used by
// the DatabaseEditor host (table list, schema view, reset, import/export) and
// by the DB0 bridge test until D1's service is wired in as
// `ShellBinding.sharesDatabaseWith` at integration. Every call runs on the
// same sqlite3* the shell has open (`fiddle_db_handle()`), through the
// DB0-local worker ops in sqlite-shell-protocol.ts. Shell writes are detected
// by re-reading total_changes()/schema_version after each completed shell
// submission (the worker's main-prompt event); D1's hook-based `change`
// events are ignored here so a page running both never sees duplicates.
import { Effect, PubSub, Stream } from "effect";
import type {
  DatabaseChange,
  DatabaseError,
  DatabaseService,
  EngineInfo,
  QueryResult,
} from "../core/types.ts";
import type { EngineWorkerClient } from "./worker-client.ts";
import {
  CONTINUATION_PROMPT,
  shellExport,
  shellImport,
  shellQuery,
  shellReset,
} from "./sqlite-shell-client.ts";

export interface SqliteShellServiceOptions {
  /** SQL that seeds the prototype database; rerun by `reset()`. */
  readonly seed?: string;
}

export interface SqliteShellService extends DatabaseService {
  /** Resolves once pending shell-write detection has run (tests). */
  idle(): Promise<void>;
  /** Stops listening to the worker; the caller owns the worker itself. */
  dispose(): void;
}

const TABLES_SQL =
  "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
const SCHEMA_SQL = "SELECT sql FROM sqlite_schema WHERE name = ?";
const SQLITE_HEADER = "SQLite format 3\0";

const isDatabaseError = (e: unknown): e is DatabaseError =>
  typeof e === "object" && e !== null &&
  (e as { _tag?: unknown })._tag === "DatabaseError";

const toDatabaseError = (
  operation: DatabaseError["operation"],
  e: unknown,
): DatabaseError =>
  isDatabaseError(e) ? { ...e, operation } : {
    _tag: "DatabaseError",
    operation,
    message: e instanceof Error ? e.message : String(e),
    cause: e,
  };

export const makeSqliteShellService = (
  client: EngineWorkerClient,
  info: EngineInfo,
  options: SqliteShellServiceOptions = {},
): Effect.Effect<SqliteShellService> =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<DatabaseChange>();
    const publish = (change: DatabaseChange) =>
      Effect.runPromise(PubSub.publish(change)(pubsub)).then(() => {});

    // Counters attributed so far (seed/app/host writes and detected shell
    // writes). The delta after a completed shell submission belongs to the
    // shell; app calls advance the baseline by their own `changes` so an app
    // read during an open shell transaction never swallows the shell's rows.
    const counters = () =>
      shellQuery(client, "SELECT 1").then((v) => ({
        total: v.totalChanges,
        schema: v.schemaVersion,
        autocommit: v.autocommit,
      }));
    let baseline = yield* Effect.promise(counters);
    let chain: Promise<unknown> = Promise.resolve();
    const serialized = <A>(run: () => Promise<A>): Promise<A> => {
      const next = chain.then(run, run);
      chain = next.catch(() => {});
      return next;
    };

    const query = (
      sql: string,
      params?: readonly unknown[],
      maxRows?: number,
    ) =>
      shellQuery(client, sql, {
        params: params as QueryResult["rows"][number] | undefined,
        maxRows,
      });

    const runSeed = async () => {
      if (options.seed) await query(options.seed);
    };

    const detectShellWrite = () =>
      serialized(async () => {
        const now = await counters();
        if (!now.autocommit) return; // wait for the shell's COMMIT/ROLLBACK
        const changes = now.total - baseline.total;
        const schemaChanged = now.schema !== baseline.schema;
        baseline = now;
        if (changes > 0 || schemaChanged) {
          await publish({
            kind: "write",
            source: "shell",
            changes,
            schemaChanged,
          });
        }
      });

    const unsubscribe = client.subscribe((event) => {
      if (
        event.family === "shell" && event.op === "prompt" &&
        event.text !== CONTINUATION_PROMPT
      ) {
        void detectShellWrite();
      }
    });

    const op = <A>(
      operation: DatabaseError["operation"],
      run: () => Promise<A>,
    ): Effect.Effect<A, DatabaseError> =>
      Effect.tryPromise(() => serialized(run)).pipe(
        Effect.mapError((e) => toDatabaseError(operation, e.cause)),
      );

    const service: SqliteShellService = {
      engine: "sqlite",
      version: info.libversion,
      persistence: {
        requested: "memory",
        actual: "memory",
        reason:
          "in-memory engine: the shell's /fiddle.sqlite3 lives on Emscripten MEMFS and is lost on reload",
      },
      capabilities: {
        persistence: {
          available: false,
          reason: "memory only in the DB0 adapter",
        },
        multiTab: { available: false, reason: "memory database" },
        export: { available: true },
        import: { available: true },
        cancellation: {
          available: false,
          reason: info.crossOriginIsolated
            ? "cancellation (SharedArrayBuffer + progress handler) is deferred by plan.md Q15"
            : "needs crossOriginIsolated (COOP/COEP) for the SharedArrayBuffer flag; this page is not isolated",
        },
      },
      execute: (sql, opts = {}) =>
        op("execute", async () => {
          const value = await query(sql, undefined, opts.maxRows);
          baseline = {
            total: baseline.total + value.changes,
            schema: value.schemaChanged ? value.schemaVersion : baseline.schema,
            autocommit: value.autocommit,
          };
          const result: QueryResult = {
            columns: value.columns,
            rows: value.rows,
            changes: value.changes,
            schemaChanged: value.schemaChanged,
            truncated: value.truncated,
          };
          if (result.changes > 0 || result.schemaChanged) {
            await publish({
              kind: "write",
              source: opts.source ?? "app",
              changes: result.changes,
              schemaChanged: result.schemaChanged,
            });
          }
          return result;
        }),
      tables: () =>
        op(
          "tables",
          async () =>
            (await query(TABLES_SQL)).rows.map((row) => String(row[0])),
        ),
      schema: (table) =>
        op("schema", async () => {
          const value = await query(SCHEMA_SQL, [table]);
          const sql = value.rows[0]?.[0];
          if (typeof sql !== "string") {
            throw new Error(`no such table: ${table}`);
          }
          return sql;
        }),
      reset: () =>
        op("reset", async () => {
          await shellReset(client);
          await runSeed();
          baseline = await counters();
          await publish({
            kind: "reset",
            source: "host",
            changes: 0,
            schemaChanged: true,
          });
        }),
      exportBytes: () =>
        op("export", async () => (await shellExport(client)).bytes),
      importBytes: (bytes) =>
        op("import", async () => {
          const header = new TextDecoder().decode(bytes.subarray(0, 16));
          if (bytes.length < 512 || header !== SQLITE_HEADER) {
            throw new Error("not an SQLite database image (bad header)");
          }
          await shellImport(client, bytes);
          baseline = await counters(); // the image has its own counters
          await publish({
            kind: "import",
            source: "host",
            changes: 0,
            schemaChanged: true,
          });
        }),
      subscribe: PubSub.subscribe(pubsub),
      changes: Stream.fromPubSub(pubsub),
      idle: () => chain.then(() => {}),
      dispose: unsubscribe,
    };
    return service;
  });

/** Seeds the database once (first open) through the structured path. */
export const seedSqliteShellService = (
  service: SqliteShellService,
  seed: string | undefined,
): Effect.Effect<void, DatabaseError> =>
  seed
    ? service.execute(seed, { source: "host" }).pipe(Effect.asVoid)
    : Effect.void;
