// @sqlite.org/sqlite-wasm under Deno: resolves to dist/node.mjs, memory-only (file opens fail SQLITE_CANTOPEN).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { wasmDeserializeInto, wasmExecute } from "./wasm-exec.ts";
import type { DriverFactory } from "./service.ts";

let modulePromise: ReturnType<typeof sqlite3InitModule> | undefined;
const loadSqlite3 = () => (modulePromise ??= sqlite3InitModule());

export const wasmMemoryFactory = (hooks: { onClose?: () => void } = {}): DriverFactory => ({
  label: "sqlite-wasm memory (Deno)",
  capabilities: { persistence: "memory", export: true, import: true, cancellation: false },
  open: async ({ bytes }) => {
    const sqlite3 = await loadSqlite3();
    const db = new sqlite3.oo1.DB(":memory:", "c");
    if (bytes) wasmDeserializeInto(sqlite3, db, bytes);
    return {
      execute: (sql) => wasmExecute(db, sql),
      exportBytes: () => sqlite3.capi.sqlite3_js_db_export(db),
      close: () => {
        db.close();
        hooks.onClose?.();
      },
    };
  },
});
