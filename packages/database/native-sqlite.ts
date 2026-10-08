// Native SQLite backend on Deno's built-in `node:sqlite` (plan.md §9, R9).
// Guards the three Deno hazards from pocs/sqlite-service: integers above 2^53
// throw unless setReadBigInts(true); prepare() keeps only the first statement
// (walk the text with .sourceSQL); reading .sourceSQL on a whitespace- or
// comment-only statement segfaults Deno (still true on 2.9.5), so leading
// trivia is stripped before every prepare().
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Effect, type Scope } from "effect";
import type { RawQueryResult } from "./sqlite-cells.ts";
import {
  type DatabaseError,
  type SqliteBackend,
  type SqliteConnection,
  SqliteExecFailure,
  TABLES_SQL,
} from "./sqlite-service.ts";

/** Strip leading whitespace, comments and empty `;` statements. */
export const skipTrivia = (sql: string): string => {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === ";" || /\s/.test(c)) i++;
    else if (sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else break;
  }
  return sql.slice(i);
};

// setReturnArrays() exists at runtime (Deno 2.9.5) but not in @types/node.
type ArrayStatement = StatementSync & { setReturnArrays(on: boolean): void };

const prepared = (db: DatabaseSync, sql: string): StatementSync => {
  const st = db.prepare(sql) as ArrayStatement;
  st.setReadBigInts(true);
  st.setReturnArrays(true);
  return st;
};

const scalar = (db: DatabaseSync, sql: string): unknown =>
  (prepared(db, sql).get() as unknown as unknown[] | undefined)?.[0];

const counters = (db: DatabaseSync) => ({
  total: Number(scalar(db, "SELECT total_changes()")),
  schema: Number(scalar(db, "PRAGMA schema_version")),
});

/** Every statement runs; columns/rows come from the first result set. */
export const nodeExecute = (
  db: DatabaseSync,
  sql: string,
  maxRows: number,
): RawQueryResult => {
  const before = counters(db);
  let columns: string[] = [];
  const rows: unknown[][] = [];
  let truncated = false;
  let gotResult = false;
  try {
    let rest = skipTrivia(sql);
    while (rest.length > 0) {
      const st = prepared(db, rest);
      const consumed = st.sourceSQL.length;
      if (consumed === 0) break; // skipTrivia guarantees a real statement
      rest = skipTrivia(rest.slice(consumed));
      const cols = st.columns();
      if (!gotResult && cols.length > 0) {
        gotResult = true;
        columns = cols.map((c) => c.name);
        for (const row of st.iterate() as Iterable<unknown[]>) {
          if (rows.length >= maxRows) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
      } else {
        st.run();
      }
    }
  } catch (e) {
    const after = counters(db);
    throw new SqliteExecFailure(
      e instanceof Error ? e.message : String(e),
      {
        changes: after.total - before.total,
        schemaChanged: after.schema !== before.schema,
      },
      e,
    );
  }
  const after = counters(db);
  return {
    columns,
    rows,
    changes: after.total - before.total,
    schemaChanged: after.schema !== before.schema,
    truncated,
  };
};

// Deno 2.9.5's node:sqlite has serialize()/deserialize(); @types/node lags.
type SerializableDb = DatabaseSync & {
  serialize(dbName?: string): Uint8Array;
  deserialize(data: Uint8Array, options?: { dbName?: string }): void;
};
const serializable = (db: DatabaseSync) => db as SerializableDb;

const connect = (db: DatabaseSync, onClose: () => void): SqliteConnection => ({
  execute: (sql, maxRows) => nodeExecute(db, sql, maxRows),
  tables: () =>
    (prepared(db, TABLES_SQL).all() as unknown as unknown[][]).map((r) =>
      String(r[0])
    ),
  schema: (table) => {
    const row = prepared(db, "SELECT sql FROM sqlite_schema WHERE name = ?")
      .get(table) as unknown as unknown[] | undefined;
    if (!row) throw new Error(`no such table: ${table}`);
    return String(row[0]);
  },
  exportBytes: () => serializable(db).serialize(),
  close: () => {
    db.close();
    onClose();
  },
});

/** Validate an image on a private memory copy before it replaces anything. */
const validated = (bytes: Uint8Array): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  try {
    serializable(db).deserialize(bytes);
    const check = scalar(db, "PRAGMA quick_check");
    if (check !== "ok") {
      throw new Error(`imported image failed quick_check: ${String(check)}`);
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
};

export type NativeSqliteOptions = {
  /** ":memory:" (default) or a file path. */
  readonly path?: string;
  /** Test hooks: connection closes and backend disposal. */
  readonly onClose?: () => void;
  readonly onDispose?: () => void;
};

export const nativeSqliteBackend = (
  options: NativeSqliteOptions = {},
): Effect.Effect<SqliteBackend, DatabaseError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync((): SqliteBackend => {
      const path = options.path ?? ":memory:";
      const memory = path === ":memory:";
      const onClose = () => options.onClose?.();
      const probe = new DatabaseSync(":memory:");
      const version = String(scalar(probe, "SELECT sqlite_version()"));
      probe.close();
      return {
        version,
        persistence: memory
          ? { requested: "memory", actual: "memory", reason: "memory database" }
          : {
            requested: "memory",
            actual: "memory",
            reason:
              `native file ${path}; browser persistence modes do not apply`,
          },
        capabilities: {
          persistence: memory
            ? { available: false, reason: "in-memory database" }
            : { available: true },
          multiTab: { available: false, reason: "native process, no tabs" },
          export: { available: true },
          import: { available: true },
          cancellation: {
            available: false,
            reason: "node:sqlite exposes no interrupt",
          },
        },
        open: ({ fresh, bytes }) => {
          const image = bytes ? validated(bytes) : undefined;
          if (memory) {
            if (!image) {
              return Promise.resolve(connect(new DatabaseSync(path), onClose));
            }
            return Promise.resolve(connect(image, onClose));
          }
          const data = image ? serializable(image).serialize() : undefined;
          image?.close();
          if (fresh || data) {
            for (const suffix of ["", "-wal", "-shm", "-journal"]) {
              try {
                Deno.removeSync(path + suffix);
              } catch { /* absent */ }
            }
          }
          if (data) Deno.writeFileSync(path, data);
          return Promise.resolve(connect(new DatabaseSync(path), onClose));
        },
      };
    }),
    () => Effect.sync(() => options.onDispose?.()),
  );
