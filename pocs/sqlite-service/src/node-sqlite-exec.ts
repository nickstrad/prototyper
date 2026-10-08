// node:sqlite (Deno built-in) execute with the same result semantics as wasmExecute.
import type { DatabaseSync } from "node:sqlite";
import { type Cell, DEFAULT_MAX_ROWS, encodeCell, type QueryResult } from "./protocol.ts";

const scalar = (db: DatabaseSync, sql: string): number => {
  const st = db.prepare(sql);
  st.setReadBigInts(true);
  st.setReturnArrays(true);
  return Number((st.get() as unknown as unknown[])[0]);
};

/**
 * Strip leading whitespace, comments and empty ';' statements.
 * Needed because in Deno 2.7.14 reading `.sourceSQL` on a statement prepared from
 * comment/whitespace-only text (null sqlite3_stmt) SEGFAULTS the process (exit 139).
 */
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

export const nodeExecute = (db: DatabaseSync, sql: string, maxRows = DEFAULT_MAX_ROWS): QueryResult => {
  const before = scalar(db, "SELECT total_changes()");
  const schemaBefore = scalar(db, "PRAGMA schema_version");
  let columns: string[] = [];
  const rows: Cell[][] = [];
  let truncated = false;
  let gotResult = false;
  // node:sqlite prepare() silently ignores everything after the first statement,
  // so walk the text using StatementSync.sourceSQL (exact prefix incl. ';').
  let rest = skipTrivia(sql);
  while (rest.length > 0) {
    const st = db.prepare(rest);
    const consumed = st.sourceSQL.length;
    if (consumed === 0) break; // defensive; skipTrivia guarantees a real statement
    rest = skipTrivia(rest.slice(consumed));
    st.setReadBigInts(true); // never throw RangeError on > 2^53 integers
    st.setReturnArrays(true);
    const cols = st.columns();
    if (!gotResult && cols.length > 0) {
      gotResult = true;
      columns = cols.map((c) => c.name);
      for (const row of st.iterate() as Iterable<unknown[]>) {
        if (rows.length >= maxRows) {
          truncated = true;
          break;
        }
        rows.push(row.map(encodeCell));
      }
    } else {
      st.run();
    }
  }
  const changes = scalar(db, "SELECT total_changes()") - before;
  const schemaChanged = scalar(db, "PRAGMA schema_version") !== schemaBefore;
  return { columns, rows, changes, schemaChanged, truncated };
};
