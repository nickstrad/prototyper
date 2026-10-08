// @sqlite.org/sqlite-wasm backend, memory only. Under Deno it resolves to
// dist/node.mjs and cannot open files (SQLITE_CANTOPEN), so it exists for the
// conformance suite: it is the browser engine's build, which catches drift
// between node:sqlite and the WASM SQLite (pocs/sqlite-service). Execute
// semantics mirror the worker's exec family (packages/database/worker.ts),
// which runs the same OO1 calls on the Fiddle engine.
import sqlite3InitModule, {
  type Database as Oo1Db,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
import { Effect, type Scope } from "effect";
import type { RawQueryResult } from "./sqlite-cells.ts";
import {
  type DatabaseError,
  type SqliteBackend,
  type SqliteConnection,
  SqliteExecFailure,
  TABLES_SQL,
  toDatabaseError,
} from "./sqlite-service.ts";

let modulePromise: Promise<Sqlite3Static> | undefined;
const loadSqlite3 = () => (modulePromise ??= sqlite3InitModule());

const counters = (sqlite3: Sqlite3Static, db: Oo1Db) => ({
  total: Number(sqlite3.capi.sqlite3_total_changes64(db)),
  schema: Number(db.selectValue("PRAGMA schema_version")),
});

export const wasmExecute = (
  sqlite3: Sqlite3Static,
  db: Oo1Db,
  sql: string,
  maxRows: number,
): RawQueryResult => {
  const before = counters(sqlite3, db);
  const columns: string[] = [];
  const rows: unknown[][] = [];
  let truncated = false;
  try {
    db.exec({
      sql,
      rowMode: "array",
      columnNames: columns,
      callback: (row: unknown) => {
        if (rows.length >= maxRows) {
          truncated = true;
          return false; // stops this statement; later statements still run
        }
        rows.push(row as unknown[]);
      },
    });
  } catch (e) {
    const after = counters(sqlite3, db);
    throw new SqliteExecFailure(
      e instanceof Error ? e.message : String(e),
      {
        changes: after.total - before.total,
        schemaChanged: after.schema !== before.schema,
      },
      e,
    );
  }
  const after = counters(sqlite3, db);
  return {
    columns,
    rows,
    changes: after.total - before.total,
    schemaChanged: after.schema !== before.schema,
    truncated,
  };
};

/** Load an exported image into a memory db via sqlite3_deserialize. */
const deserializeInto = (
  sqlite3: Sqlite3Static,
  db: Oo1Db,
  bytes: Uint8Array,
) => {
  const { capi, wasm } = sqlite3;
  const p = wasm.allocFromTypedArray(bytes);
  const rc = capi.sqlite3_deserialize(
    db.pointer!,
    "main",
    p,
    bytes.byteLength,
    bytes.byteLength,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  if (rc !== 0) {
    wasm.dealloc(p);
    throw new Error(
      `sqlite3_deserialize failed: ${capi.sqlite3_js_rc_str(rc)}`,
    );
  }
  // sqlite3_deserialize accepts garbage after a valid header.
  const check = db.selectValue("PRAGMA quick_check");
  if (check !== "ok") {
    throw new Error(`imported image failed quick_check: ${String(check)}`);
  }
};

const connect = (
  sqlite3: Sqlite3Static,
  db: Oo1Db,
  onClose: () => void,
): SqliteConnection => ({
  execute: (sql, maxRows) => wasmExecute(sqlite3, db, sql, maxRows),
  tables: () =>
    (db.selectValues(TABLES_SQL) as unknown[]).map((v) => String(v)),
  schema: (table) => {
    // Bound as a parameter by OO1 (Stmt.bind), not concatenated.
    const sql = db.selectValue(
      "SELECT sql FROM sqlite_schema WHERE name = ?",
      [table],
    );
    if (sql === undefined) throw new Error(`no such table: ${table}`);
    return String(sql);
  },
  exportBytes: () => sqlite3.capi.sqlite3_js_db_export(db),
  close: () => {
    db.close();
    onClose();
  },
});

export type SqliteWasmOptions = {
  readonly onClose?: () => void;
  readonly onDispose?: () => void;
};

export const sqliteWasmMemoryBackend = (
  options: SqliteWasmOptions = {},
): Effect.Effect<SqliteBackend, DatabaseError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async (): Promise<SqliteBackend> => {
        const sqlite3 = await loadSqlite3();
        const onClose = () => options.onClose?.();
        return {
          version: sqlite3.version.libVersion,
          persistence: {
            requested: "memory",
            actual: "memory",
            reason: "sqlite-wasm under Deno is memory only",
          },
          capabilities: {
            persistence: {
              available: false,
              reason: "sqlite-wasm under Deno cannot open files",
            },
            multiTab: { available: false, reason: "native process, no tabs" },
            export: { available: true },
            import: { available: true },
            cancellation: {
              available: false,
              reason: "no interrupt wired for the in-process engine",
            },
          },
          open: ({ bytes }) => {
            const db = new sqlite3.oo1.DB(":memory:", "c");
            try {
              if (bytes) deserializeInto(sqlite3, db, bytes);
            } catch (e) {
              db.close();
              return Promise.reject(e);
            }
            return Promise.resolve(connect(sqlite3, db, onClose));
          },
        };
      },
      catch: toDatabaseError("open"),
    }),
    () => Effect.sync(() => options.onDispose?.()),
  );
