// OO1-based execute for @sqlite.org/sqlite-wasm. Runs in a browser Worker or in Deno.
import { type Cell, DEFAULT_MAX_ROWS, encodeCell, type QueryResult } from "./protocol.ts";

import type { Database as OO1Db, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

export const wasmExecute = (db: OO1Db, sql: string, maxRows = DEFAULT_MAX_ROWS): QueryResult => {
  const before = Number(db.changes(true));
  const schemaBefore = Number(db.selectValue("PRAGMA schema_version"));
  const columns: string[] = [];
  const rows: Cell[][] = [];
  let truncated = false;
  db.exec({
    sql,
    rowMode: "array",
    columnNames: columns,
    callback: (row: unknown) => {
      if (rows.length >= maxRows) {
        truncated = true;
        return false; // stops stepping this statement only; later statements still run
      }
      rows.push((row as unknown[]).map(encodeCell));
    },
  });
  const changes = Number(db.changes(true)) - before;
  const schemaChanged = Number(db.selectValue("PRAGMA schema_version")) !== schemaBefore;
  return { columns, rows, changes, schemaChanged, truncated };
};


/** Load an exported image into an open (memory) OO1 db via sqlite3_deserialize. */
export const wasmDeserializeInto = (sqlite3: Sqlite3Static, db: OO1Db, bytes: Uint8Array) => {
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
    throw new Error(`sqlite3_deserialize failed: ${capi.sqlite3_js_rc_str(rc)}`);
  }
};
