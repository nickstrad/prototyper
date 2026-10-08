// Effect v4 (4.0.2) DatabaseService: Context.Service + Layer.effect + acquireRelease,
// Semaphore-serialized operations, atomic handle swap on reset/import, PubSub change events.
import { Context, Data, Effect, Layer, PubSub, Ref, Scope, Semaphore, Stream } from "effect";
import type { QueryResult } from "./protocol.ts";

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

/** One open engine handle (memory db, OPFS db, worker-backed db, node:sqlite db). */
export interface Driver {
  readonly execute: (sql: string) => QueryResult | Promise<QueryResult>;
  readonly exportBytes: () => Uint8Array | Promise<Uint8Array>;
  readonly close: () => void | Promise<void>;
}

export interface DriverFactory {
  readonly label: string;
  readonly capabilities: Capabilities;
  /** fresh=true wipes persisted storage first; bytes=... opens a copy of an exported image. */
  readonly open: (opts: { fresh: boolean; bytes?: Uint8Array }) => Promise<Driver>;
}

export type Capabilities = {
  readonly persistence: "memory" | "opfs" | "opfs-sahpool" | "file";
  readonly export: boolean;
  readonly import: boolean;
  readonly cancellation: boolean;
};

export type DbEvent =
  | { readonly _tag: "Changed"; readonly changes: number; readonly schemaChanged: boolean }
  | { readonly _tag: "Reset" }
  | { readonly _tag: "Imported" };

export interface DatabaseShape {
  readonly engine: "sqlite";
  readonly label: string;
  readonly capabilities: Capabilities;
  readonly execute: (sql: string) => Effect.Effect<QueryResult, DatabaseError>;
  readonly tables: () => Effect.Effect<readonly string[], DatabaseError>;
  readonly schema: (table: string) => Effect.Effect<string, DatabaseError>;
  readonly reset: () => Effect.Effect<void, DatabaseError>;
  readonly exportBytes: () => Effect.Effect<Uint8Array, DatabaseError>;
  readonly importBytes: (bytes: Uint8Array) => Effect.Effect<void, DatabaseError>;
  /** Scoped subscription: guaranteed to see every event published after it resolves. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<DbEvent>, never, Scope.Scope>;
  readonly changes: Stream.Stream<DbEvent>;
}

export class Database extends Context.Service<Database, DatabaseShape>()("prototyper/Database") {}

export type DatabaseOptions = {
  readonly factory: DriverFactory;
  readonly schema: string;
  readonly seed: string;
};

const fail = (operation: string) => (cause: unknown) =>
  new DatabaseError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

const call = <A>(operation: string, f: () => A | Promise<A>) =>
  Effect.tryPromise({ try: async () => await f(), catch: fail(operation) });

const SQLITE_HEADER = "SQLite format 3\0";
const isSqliteImage = (b: Uint8Array) =>
  b.length >= 512 && String.fromCharCode(...b.subarray(0, 16)) === SQLITE_HEADER;

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Apply schema+seed once per database file (PRAGMA user_version marks it). */
const initialize = (driver: Driver, opts: DatabaseOptions) =>
  call("initialize", async () => {
    const v = await driver.execute("PRAGMA user_version");
    if (v.rows[0]?.[0] === 0) {
      await driver.execute(`BEGIN; ${opts.schema}; ${opts.seed}; PRAGMA user_version = 1; COMMIT;`);
    }
  });

/** sqlite3_deserialize accepts garbage after a valid header; verify before going live. */
const verifyImage = (driver: Driver) =>
  call("import", async () => {
    const r = await driver.execute("PRAGMA quick_check");
    if (r.rows[0]?.[0] !== "ok") throw new Error(`imported image failed quick_check: ${JSON.stringify(r.rows[0]?.[0])}`);
  }).pipe(Effect.tapError(() => call("import", () => driver.close()).pipe(Effect.ignore)));

export const make = (opts: DatabaseOptions) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const pubsub = yield* PubSub.unbounded<DbEvent>();
    // The service object never changes; only this Ref's driver is swapped.
    const current = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const driver = yield* call("open", () => opts.factory.open({ fresh: false }));
        yield* initialize(driver, opts);
        return yield* Ref.make<Driver | undefined>(driver);
      }),
      (ref) =>
        Effect.gen(function* () {
          const d = yield* Ref.get(ref);
          if (d) yield* Effect.promise(async () => await d.close());
          yield* PubSub.shutdown(pubsub);
        }),
    );

    const withDriver = <A>(operation: string, f: (d: Driver) => A | Promise<A>) =>
      Effect.gen(function* () {
        const d = yield* Ref.get(current);
        if (!d) return yield* Effect.fail(fail(operation)(new Error("database is closed (failed reset/import?)")));
        return yield* call(operation, () => f(d));
      });

    const swap = (operation: string, next: { fresh: boolean; bytes?: Uint8Array }, event: DbEvent) =>
      Effect.gen(function* () {
        const old = yield* Ref.get(current);
        // Snapshot before an import so a failed import can restore the previous data.
        const snapshot = next.bytes && old ? yield* call(operation, () => old.exportBytes()) : undefined;
        // Close first: opfs-sahpool / opfs cannot open a second handle on the same file.
        yield* Ref.set(current, undefined);
        if (old) yield* call(operation, () => old.close());
        const opened = yield* call(operation, () => opts.factory.open(next)).pipe(
          Effect.tap((driver) => (next.bytes ? verifyImage(driver) : Effect.void)),
          Effect.tap((driver) => initialize(driver, opts)),
          Effect.exit,
        );
        if (opened._tag === "Success") {
          yield* Ref.set(current, opened.value);
          yield* PubSub.publish(pubsub, event);
          return;
        }
        // Recover (previous snapshot, else fresh seeds) so the prototype stays usable, then report the failure.
        const fallback = yield* call("recover", () => opts.factory.open({ fresh: true, bytes: snapshot }));
        yield* initialize(fallback, opts);
        yield* Ref.set(current, fallback);
        if (!snapshot) yield* PubSub.publish(pubsub, { _tag: "Reset" });
        return yield* opened;
      }).pipe(lock.withPermit);

    const execute = (sql: string) =>
      withDriver("execute", (d) => d.execute(sql)).pipe(
        Effect.tap((r) =>
          r.changes > 0 || r.schemaChanged
            ? PubSub.publish(pubsub, { _tag: "Changed", changes: r.changes, schemaChanged: r.schemaChanged })
            : Effect.void
        ),
        lock.withPermit,
      );

    const service: DatabaseShape = {
      engine: "sqlite",
      label: opts.factory.label,
      capabilities: opts.factory.capabilities,
      execute,
      tables: () =>
        withDriver("tables", (d) =>
          d.execute("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        ).pipe(Effect.map((r) => r.rows.map((row) => String(row[0]))), lock.withPermit),
      schema: (table) =>
        withDriver("schema", (d) => d.execute(`SELECT sql FROM sqlite_schema WHERE name = ${quote(table)}`)).pipe(
          Effect.flatMap((r) =>
            r.rows.length === 0
              ? Effect.fail(fail("schema")(new Error(`no such table: ${table}`)))
              : Effect.succeed(String(r.rows[0][0]))
          ),
          lock.withPermit,
        ),
      reset: () => swap("reset", { fresh: true }, { _tag: "Reset" }),
      exportBytes: () => withDriver("export", (d) => d.exportBytes()).pipe(lock.withPermit),
      importBytes: (bytes) =>
        isSqliteImage(bytes)
          ? swap("import", { fresh: true, bytes }, { _tag: "Imported" })
          : Effect.fail(fail("import")(new Error("not an SQLite database image (bad header)"))),
      subscribe: PubSub.subscribe(pubsub),
      changes: Stream.fromPubSub(pubsub),
    };
    return service;
  });

export const layer = (opts: DatabaseOptions): Layer.Layer<Database, DatabaseError> =>
  Layer.effect(Database, make(opts));
