// DuckDB DatabaseService (plan.md §9, D2) on one `AsyncDuckDB` worker per
// service instance (duckdb-engine.ts). The same rules as the SQLite service
// (sqlite-service.ts), applied to DuckDB:
//
// - scoped acquisition: the worker, the database and the app connection are
//   acquired with acquireRelease; closing the scope closes the connection and
//   terminates the worker (`db.terminate()`);
// - execute, tables, schema, export, reset and import share one permit;
// - reset and import close the app connection, open a new one and replace the
//   catalog inside one transaction (ROLLBACK restores the data on failure),
//   so the service object and the engine instance never change — a shell
//   bound to the same `AsyncDuckDB` keeps working;
// - `changes` sums the `Count` of INSERT/UPDATE/DELETE/MERGE/COPY FROM
//   statements (DuckDB has no total_changes()); `schemaChanged` is a catalog
//   diff (tables, views, indexes, sequences, macros, types, schemas) taken
//   before and after the script;
// - a write (changes > 0 || schemaChanged) publishes exactly one change event
//   after it succeeded; a failing script publishes one only for the part that
//   was already applied;
// - with `opfs://` persistence every write is followed by CHECKPOINT (an
//   unchecked write is lost on reload, pocs/duckdb-shell evidence/60);
// - scripts are split with DuckDB's own tokenizer; ATTACH and `opfs://`
//   literals are refused, and `AsyncDuckDB.open` is blocked, so the service
//   never opens a path other than the one chosen at startup (Q12/Q17);
// - Arrow results are converted by type in duckdb-cells.ts.
import { Effect, Layer, PubSub, Ref, Semaphore, Stream } from "effect";
import type { Scope } from "effect";
import type {
  DatabaseChange,
  DatabaseService,
  QueryResult,
} from "../core/types.ts";
import { Database, DatabaseError } from "./sqlite-service.ts";
import type { DatabaseOperation } from "./sqlite-service.ts";
import {
  type AsyncDuckDB,
  type AsyncDuckDBConnection,
  type DuckDbEngine,
  type DuckDbEngineOptions,
  startDuckDb,
} from "./duckdb-engine.ts";
import { tableRows } from "./duckdb-cells.ts";

export { Database, DatabaseError };

export type DuckDbServiceOptions = DuckDbEngineOptions & {
  /** Applied with `seed` when the database has no user objects yet. */
  readonly schema: string;
  readonly seed: string;
  readonly maxRows?: number;
  /** Test hooks: app-connection closes and worker termination. */
  readonly onClose?: () => void;
  readonly onDispose?: () => void;
  /** Test seam: runs before every CHECKPOINT; throwing simulates a failure. */
  readonly onCheckpoint?: () => void | Promise<void>;
};

export const DEFAULT_MAX_ROWS = 1000;

/** What a shell binding (DB1) needs from a live DuckDB service. */
export type DuckDbHandle = {
  /** The service's one engine instance; never reopen it (open is blocked). */
  readonly db: AsyncDuckDB;
  readonly path: string;
  /** For `shell.embed({ resolveDatabase })`. */
  resolveDatabase(): Promise<AsyncDuckDB>;
  /**
   * Report a write made outside the service (the shell): publishes the event
   * and, with OPFS, checkpoints. No-op for `changes === 0 && !schemaChanged`.
   */
  publishExternal(change: DatabaseChange): Promise<void>;
};

const handles = new WeakMap<DatabaseService, DuckDbHandle>();

/** The engine handle behind a DuckDB service (undefined for other engines). */
export const duckDbHandle = (
  service: DatabaseService,
): DuckDbHandle | undefined => handles.get(service);

/** `resolveDatabase` for `@duckdb/duckdb-wasm-shell`'s `embed()`. */
export const resolveDatabase =
  (service: DatabaseService) => (): Promise<AsyncDuckDB> => {
    const handle = handles.get(service);
    return handle
      ? handle.resolveDatabase()
      : Promise.reject(new Error("not a DuckDB DatabaseService"));
  };

// ---- errors -------------------------------------------------------------------

const describe = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
};

/** A script failed after applying `partial`. */
class ExecFailure extends Error {
  constructor(
    readonly original: unknown,
    readonly partial: {
      changes: number;
      schemaChanged: boolean;
      uncounted: boolean;
    },
    message = describe(original),
  ) {
    super(message);
  }
}

const toDatabaseError =
  (operation: DatabaseOperation) => (cause: unknown): DatabaseError => {
    if (cause instanceof DatabaseError) return cause;
    return new DatabaseError({ operation, message: describe(cause), cause });
  };

const call = <A>(operation: DatabaseOperation, f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: toDatabaseError(operation) });

const isWrite = (
  r: { changes: number; schemaChanged: boolean; uncounted?: boolean },
) => r.changes > 0 || r.schemaChanged || r.uncounted === true;

const sqlString = (s: string): string => `'${s.replaceAll("'", "''")}'`;
const ident = (s: string): string => `"${s.replaceAll('"', '""')}"`;

// ---- statements ---------------------------------------------------------------

/** DuckDB tokenizer token types (bindings/tokens.d.ts). */
const TOKEN = { STRING: 2, OPERATOR: 3, KEYWORD: 4 } as const;

type Kind = "query" | "dml" | "returning" | "other";
type Classified = {
  readonly kind: Kind;
  /** Cannot change data or the catalog (no catalog diff, no CHECKPOINT). */
  readonly readOnly: boolean;
  /**
   * Writes, but DuckDB reports no row count (EXPLAIN ANALYZE <write>):
   * published as a write and checkpointed even when `changes` is 0.
   */
  readonly uncounted?: boolean;
  /** Opens or ends an explicit transaction on the app connection. */
  readonly txn?: "begin" | "end";
  /** PREPARE: recorded for the connection only once DuckDB accepted it. */
  readonly prepare?: { readonly name: string; readonly as: Classified };
  /** DEALLOCATE: forgotten once DuckDB accepted it. */
  readonly deallocate?: string;
  /** EXECUTE: resolved against the connection's PREPAREs when it runs. */
  readonly execute?: string;
};
type Statement = Classified & { readonly text: string };

/** Per-connection facts the tokenizer cannot see from one statement. */
type ConnState = {
  inTransaction: boolean;
  /** PREPAREd statement name → its classification (for EXECUTE). */
  readonly prepared: Map<string, Classified>;
};

/** Leading words of statements that produce a result set. */
const QUERY = new Set([
  "SELECT",
  "FROM",
  "VALUES",
  "TABLE",
  "WITH",
  "SHOW",
  "DESCRIBE",
  "SUMMARIZE",
  "EXPLAIN",
  "PRAGMA",
  "CALL",
  "PIVOT",
  "UNPIVOT",
  "(",
]);
/** Statements whose result is a `Count` of affected rows. */
const DML = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE"]);
const READ_ONLY = new Set([
  "SELECT",
  "FROM",
  "VALUES",
  "TABLE",
  "SHOW",
  "DESCRIBE",
  "SUMMARIZE",
  "EXPLAIN",
  "(",
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Token = { readonly type: number; readonly text: string };
type TokenizedStatement = {
  readonly text: string;
  readonly tokens: readonly Token[];
};

/** Upper-cased leading word of a token ("(" for operators). */
const wordOf = (token: Token | undefined): string => {
  if (!token) return "";
  return (/^[A-Za-z_][A-Za-z0-9_]*/.exec(token.text)?.[0] ??
    token.text.slice(0, 1)).toUpperCase();
};

/** Identifier text of a token: unquoted names fold to lower case. */
const nameOf = (token: Token | undefined): string => {
  const text = token?.text ?? "";
  return text.startsWith('"')
    ? text.slice(1, -1).replaceAll('""', '"')
    : (/^[^\s(;]+/.exec(text)?.[0] ?? "").toLowerCase();
};

/**
 * Splits a script into statements with DuckDB's tokenizer (strings, quoted
 * identifiers and comments are its business, not ours). Token offsets are
 * UTF-8 byte offsets. Comment-only segments are dropped.
 */
const tokenizeScript = async (
  db: AsyncDuckDB,
  sql: string,
): Promise<TokenizedStatement[]> => {
  const bytes = encoder.encode(sql);
  const { offsets, types } = await db.tokenize(sql);
  const tokenText = (k: number) =>
    decoder.decode(bytes.subarray(offsets[k], offsets[k + 1] ?? bytes.length))
      .trim();
  const statements: TokenizedStatement[] = [];
  let tokens: Token[] = [];
  let start = 0;
  const flush = (endByte: number) => {
    if (tokens.length > 0) {
      statements.push({
        text: decoder.decode(bytes.subarray(start, endByte)),
        tokens,
      });
    }
    tokens = [];
    start = endByte + 1;
  };
  for (let k = 0; k < offsets.length; k++) {
    if (types[k] === TOKEN.OPERATOR && bytes[offsets[k]] === 0x3b) { // ';'
      flush(offsets[k]);
    } else {
      tokens.push({ type: types[k], text: tokenText(k) });
    }
  }
  flush(bytes.length);
  return statements;
};

/**
 * Refuses ATTACH and `opfs:` string literals before anything runs. This is
 * an early, readable refusal only: the real guard for `opfs://` paths is the
 * engine's `opfs.fileHandling: "manual"` (duckdb-engine.ts), under which an
 * unregistered `opfs://` path cannot be opened however it is spelled
 * (`$$opfs://x$$`, `"opfs://x"`), and `AsyncDuckDB.open` is blocked.
 */
const guard = (tokens: readonly Token[]): void => {
  if (tokens.some((t) => t.type === TOKEN.KEYWORD && wordOf(t) === "ATTACH")) {
    throw new Error(
      "ATTACH is blocked: the service only uses its own database (plan.md Q12/Q17)",
    );
  }
  if (
    tokens.some((t) => t.type === TOKEN.STRING && /^[eE]?'opfs:/i.test(t.text))
  ) {
    throw new Error(
      "opfs:// paths are blocked: the service only uses its own database file (plan.md Q12/Q17)",
    );
  }
};

/** What a statement does, from its tokens (and PREPAREs seen before). */
const classify = (tokens: readonly Token[], state: ConnState): Classified => {
  const head = wordOf(tokens[0]);
  const keywords = tokens.filter((t) => t.type === TOKEN.KEYWORD).map(wordOf);
  switch (head) {
    case "EXPLAIN": {
      if (wordOf(tokens[1]) !== "ANALYZE") {
        return { kind: "query", readOnly: true };
      }
      // EXPLAIN ANALYZE runs the statement; its result is the plan.
      const inner = classify(tokens.slice(2), state);
      return inner.readOnly
        ? { kind: "query", readOnly: true }
        : { kind: "query", readOnly: false, uncounted: true };
    }
    case "PREPARE": {
      const as = tokens.findIndex((t, k) => k > 1 && wordOf(t) === "AS");
      return {
        kind: "other",
        readOnly: true,
        prepare: {
          name: nameOf(tokens[1]),
          as: classify(tokens.slice(as + 1), state),
        },
      };
    }
    case "EXECUTE":
      // Resolved at run time (runScript): a PREPARE earlier in the same
      // script, or a failed re-PREPARE, must be taken into account.
      return {
        kind: "query",
        readOnly: false,
        uncounted: true,
        execute: nameOf(tokens[1]),
      };
    case "DEALLOCATE": {
      const k = wordOf(tokens[1]) === "PREPARE" ? 2 : 1;
      return { kind: "other", readOnly: true, deallocate: nameOf(tokens[k]) };
    }
    case "BEGIN":
    case "START":
      return { kind: "other", readOnly: true, txn: "begin" };
    case "COMMIT":
    case "END":
      return { kind: "other", readOnly: false, txn: "end" };
    case "ROLLBACK":
    case "ABORT":
      return { kind: "other", readOnly: true, txn: "end" };
  }
  let kind: Kind = "other";
  if (head === "WITH" && keywords.some((w) => DML.has(w))) kind = "dml";
  else if (QUERY.has(head)) kind = "query";
  else if (DML.has(head)) kind = "dml";
  else if (head === "COPY" && !keywords.includes("TO")) kind = "dml";
  if (kind === "dml" && keywords.includes("RETURNING")) kind = "returning";
  return { kind, readOnly: READ_ONLY.has(head) };
};

/** Tokenizes, guards and classifies a script (throws before running any). */
const splitScript = async (
  db: AsyncDuckDB,
  sql: string,
  state: ConnState,
): Promise<Statement[]> => {
  const statements = await tokenizeScript(db, sql);
  for (const s of statements) guard(s.tokens);
  return statements.map((s) => ({
    text: s.text,
    ...classify(s.tokens, state),
  }));
};

/** One line per catalog object of the current and the temp database. */
const CATALOG_SQL =
  `SELECT coalesce(string_agg(x, chr(10) ORDER BY x), '') FROM (
  SELECT 't|' || database_name || '|' || schema_name || '|' || table_name || '|' || coalesce(sql, '') AS x FROM duckdb_tables() WHERE database_name IN (current_database(), 'temp')
  UNION ALL SELECT 'v|' || database_name || '|' || schema_name || '|' || view_name || '|' || coalesce(sql, '') FROM duckdb_views() WHERE NOT internal AND database_name IN (current_database(), 'temp')
  UNION ALL SELECT 'i|' || database_name || '|' || schema_name || '|' || index_name || '|' || coalesce(sql, '') FROM duckdb_indexes() WHERE database_name IN (current_database(), 'temp')
  UNION ALL SELECT 's|' || database_name || '|' || schema_name || '|' || sequence_name FROM duckdb_sequences() WHERE database_name IN (current_database(), 'temp')
  UNION ALL SELECT 'm|' || database_name || '|' || schema_name || '|' || function_name || '|' || coalesce(macro_definition, '') FROM duckdb_functions() WHERE NOT internal AND function_type IN ('macro', 'table_macro') AND database_name IN (current_database(), 'temp')
  UNION ALL SELECT 'y|' || database_name || '|' || schema_name || '|' || type_name FROM duckdb_types() WHERE NOT internal AND database_name IN (current_database(), 'temp')
  UNION ALL SELECT 'c|' || database_name || '|' || schema_name FROM duckdb_schemas() WHERE NOT internal AND database_name IN (current_database(), 'temp')
)`;

const scalar = async (conn: AsyncDuckDBConnection, sql: string) =>
  (await conn.query(sql)).getChildAt(0)?.get(0);

/** Catalog fingerprint; null when it cannot be read (aborted transaction). */
const catalog = async (conn: AsyncDuckDBConnection): Promise<string | null> => {
  try {
    return String(await scalar(conn, CATALOG_SQL));
  } catch {
    return null;
  }
};

type Partial = {
  readonly changes: number;
  readonly schemaChanged: boolean;
  /** A statement wrote without a row count (EXPLAIN ANALYZE <write>). */
  readonly uncounted: boolean;
};

type Raw = Partial & {
  readonly columns: string[];
  readonly rows: QueryResult["rows"];
  readonly truncated: boolean;
  /** Something other than a pure read ran: CHECKPOINT with OPFS. */
  readonly wrote: boolean;
};

/** Runs every statement; columns/rows come from the first result set. */
const runScript = async (
  conn: AsyncDuckDBConnection,
  state: ConnState,
  statements: readonly Statement[],
  maxRows: number,
): Promise<Raw> => {
  const diff = statements.some((s) => !s.readOnly);
  const before = diff ? await catalog(conn) : null;
  let columns: string[] = [];
  let rows: QueryResult["rows"] = [];
  let truncated = false;
  let changes = 0;
  let uncounted = false;
  let resultSet = false;
  const schemaMoved = async () => {
    if (!diff) return false;
    const after = await catalog(conn);
    return before !== null && after !== null && before !== after;
  };
  for (const planned of statements) {
    // EXECUTE takes the kind of the statement PREPAREd under that name; an
    // unknown name (DuckDB refuses it) stays a conservative uncounted write.
    const prepared = planned.execute === undefined
      ? undefined
      : state.prepared.get(planned.execute);
    const statement: Statement = prepared
      ? { ...prepared, text: planned.text, readOnly: false }
      : planned;
    let table;
    try {
      table = await conn.query(statement.text);
    } catch (e) {
      // A failed COMMIT/ROLLBACK still ends the transaction in DuckDB (and
      // one without a transaction had none): never leave the flag stuck.
      if (statement.txn === "end") state.inTransaction = false;
      throw new ExecFailure(e, {
        changes,
        schemaChanged: await schemaMoved(),
        uncounted,
      });
    }
    if (statement.txn) state.inTransaction = statement.txn === "begin";
    if (statement.prepare) {
      state.prepared.set(statement.prepare.name, statement.prepare.as);
    }
    if (statement.deallocate !== undefined) {
      state.prepared.delete(statement.deallocate);
    }
    if (statement.uncounted) uncounted = true;
    if (statement.kind === "dml") {
      const count = table.schema.fields[0]?.name === "Count"
        ? table.getChildAt(0)?.get(0)
        : undefined;
      if (count === undefined || count === null) uncounted = true;
      else changes += Number(count);
    } else if (statement.kind === "returning") {
      changes += table.numRows;
    }
    if (
      !resultSet &&
      (statement.kind === "query" || statement.kind === "returning")
    ) {
      resultSet = true;
      const converted = tableRows(table, maxRows);
      columns = table.schema.fields.map((f) => f.name);
      rows = converted.rows;
      truncated = converted.truncated;
    }
  }
  return {
    columns,
    rows,
    truncated,
    changes,
    uncounted,
    schemaChanged: await schemaMoved(),
    wrote: diff,
  };
};

// ---- catalog maintenance -------------------------------------------------------

const USER_OBJECTS_SQL = `SELECT
  (SELECT count(*) FROM duckdb_tables() WHERE database_name = current_database())
  + (SELECT count(*) FROM duckdb_views() WHERE NOT internal AND database_name = current_database())
  + (SELECT count(*) FROM duckdb_sequences() WHERE database_name = current_database())
  + (SELECT count(*) FROM duckdb_functions() WHERE NOT internal AND function_type IN ('macro', 'table_macro') AND database_name = current_database())
  + (SELECT count(*) FROM duckdb_types() WHERE NOT internal AND database_name = current_database())
  + (SELECT count(*) FROM duckdb_schemas() WHERE NOT internal AND database_name = current_database())`;

const rowsOf = async (conn: AsyncDuckDBConnection, sql: string) =>
  (await conn.query(sql)).toArray().map((r) =>
    r.toJSON() as Record<string, unknown>
  );

/** DROP statements that empty the current database (main schema kept). */
const dropAllSql = async (conn: AsyncDuckDBConnection): Promise<string> => {
  const where = "database_name = current_database() AND schema_name = 'main'";
  const q = (schema: unknown, name: unknown) =>
    `${ident(String(schema))}.${ident(String(name))}`;
  const out: string[] = [];
  for (
    const r of await rowsOf(
      conn,
      `SELECT schema_name FROM duckdb_schemas() WHERE NOT internal AND database_name = current_database() AND schema_name <> 'main'`,
    )
  ) out.push(`DROP SCHEMA ${ident(String(r.schema_name))} CASCADE`);
  for (
    const r of await rowsOf(
      conn,
      `SELECT schema_name, view_name FROM duckdb_views() WHERE NOT internal AND ${where}`,
    )
  ) out.push(`DROP VIEW IF EXISTS ${q(r.schema_name, r.view_name)}`);
  for (
    const r of await rowsOf(
      conn,
      `SELECT DISTINCT schema_name, function_name, function_type FROM duckdb_functions() WHERE NOT internal AND function_type IN ('macro', 'table_macro') AND ${where}`,
    )
  ) {
    out.push(
      `DROP MACRO ${
        r.function_type === "table_macro" ? "TABLE " : ""
      }IF EXISTS ${q(r.schema_name, r.function_name)}`,
    );
  }
  for (
    const r of await rowsOf(
      conn,
      `SELECT schema_name, table_name FROM duckdb_tables() WHERE ${where}`,
    )
  ) out.push(`DROP TABLE IF EXISTS ${q(r.schema_name, r.table_name)} CASCADE`);
  for (
    const r of await rowsOf(
      conn,
      `SELECT schema_name, sequence_name FROM duckdb_sequences() WHERE ${where}`,
    )
  ) out.push(`DROP SEQUENCE IF EXISTS ${q(r.schema_name, r.sequence_name)}`);
  for (
    const r of await rowsOf(
      conn,
      `SELECT schema_name, type_name FROM duckdb_types() WHERE NOT internal AND ${where}`,
    )
  ) out.push(`DROP TYPE IF EXISTS ${q(r.schema_name, r.type_name)}`);
  return out.map((s) => `${s};`).join("\n");
};

/** Runs `body` inside BEGIN/COMMIT; ROLLBACK (restoring data) on failure. */
const transaction = async (
  conn: AsyncDuckDBConnection,
  body: () => Promise<void>,
): Promise<void> => {
  await conn.query("BEGIN TRANSACTION");
  try {
    await body();
    await conn.query("COMMIT");
  } catch (e) {
    try {
      await conn.query("ROLLBACK");
    } catch { /* already rolled back */ }
    throw e;
  }
};

// ---- export / import container -------------------------------------------------

/**
 * `exportBytes()` image: DuckDB's own `EXPORT DATABASE … (FORMAT parquet)`
 * output (schema.sql, load.sql, one parquet file per table) in one buffer:
 * this magic line, a JSON manifest line, then the files back to back.
 * (A `.duckdb` file image is not available: a database ATTACHed on the wasm
 * buffer file system stays locked after DETACH, so it cannot be read back.)
 */
export const DUCKDB_EXPORT_MAGIC = "PROTOTYPER-DUCKDB-EXPORT 1\n";

export type Manifest = {
  readonly engine: "duckdb";
  readonly version: string;
  readonly dir: string;
  readonly files: readonly { readonly name: string; readonly size: number }[];
};

const EXPORT_DIR = /^__prototyper_export_[a-z0-9_]{1,40}$/;
const EXPORT_FILE = /^[A-Za-z0-9_.-]{1,200}$/;

/** Builds an export image (exported for tests that craft images). */
export const packExport = (
  manifest: Manifest,
  files: readonly Uint8Array[],
): Uint8Array => {
  const head = encoder.encode(
    DUCKDB_EXPORT_MAGIC + JSON.stringify(manifest) + "\n",
  );
  const out = new Uint8Array(
    head.length + files.reduce((n, f) => n + f.length, 0),
  );
  out.set(head, 0);
  let at = head.length;
  for (const f of files) {
    out.set(f, at);
    at += f.length;
  }
  return out;
};

/** Parses and validates an export image; throws before touching anything. */
export const unpackExport = (
  bytes: Uint8Array,
): { manifest: Manifest; files: Uint8Array[] } => {
  const bad = (why: string) => new Error(`not a DuckDB export image (${why})`);
  const magic = encoder.encode(DUCKDB_EXPORT_MAGIC);
  if (
    bytes.length < magic.length ||
    !magic.every((b, k) => bytes[k] === b)
  ) throw bad("bad header");
  const nl = bytes.indexOf(0x0a, magic.length);
  if (nl < 0) throw bad("no manifest");
  let manifest: Manifest;
  try {
    manifest = JSON.parse(decoder.decode(bytes.subarray(magic.length, nl)));
  } catch {
    throw bad("unreadable manifest");
  }
  if (
    manifest?.engine !== "duckdb" || typeof manifest.dir !== "string" ||
    !EXPORT_DIR.test(manifest.dir) || !Array.isArray(manifest.files) ||
    !manifest.files.every((f) =>
      typeof f?.name === "string" && EXPORT_FILE.test(f.name) &&
      Number.isInteger(f.size) && f.size >= 0
    ) ||
    !["schema.sql", "load.sql"].every((n) =>
      manifest.files.some((f) => f.name === n)
    )
  ) throw bad("bad manifest");
  const files: Uint8Array[] = [];
  let at = nl + 1;
  for (const f of manifest.files) {
    files.push(bytes.slice(at, at + f.size));
    at += f.size;
  }
  if (at !== bytes.length) throw bad("size mismatch");
  return { manifest, files };
};

/** CREATE kinds DuckDB's EXPORT DATABASE writes to schema.sql. */
const SCHEMA_CREATES = new Set([
  "SCHEMA",
  "SEQUENCE",
  "TYPE",
  "TABLE",
  "VIEW",
  "INDEX",
  "UNIQUE",
  "MACRO",
  "FUNCTION",
]);
/** Words that never appear in an exported CREATE statement. */
const SCHEMA_DENIED = new Set([
  "ATTACH",
  "DETACH",
  "SET",
  "RESET",
  "INSTALL",
  "LOAD",
  "PRAGMA",
  "CALL",
  "COPY",
  "EXPORT",
  "IMPORT",
  "CHECKPOINT",
  "USE",
  "VACUUM",
]);
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;

type Refuse = (file: string, statement: string, why: string) => never;

/** Net bracket depth change of an operator token ("(", "))", …). */
const depthDelta = (t: Token): number =>
  t.type === TOKEN.OPERATOR
    ? [...t.text].reduce(
      (d, c) => d + (c === "(" ? 1 : c === ")" ? -1 : 0),
      0,
    )
    : 0;

/**
 * `CREATE TABLE <name> ( <columns and constraints> )` and nothing else:
 * only a (qualified) name before the column list, and no token after the
 * bracket that closes it — so neither `CREATE TABLE t AS …`,
 * `CREATE TABLE t AS (SELECT …)` nor `CREATE TABLE t (a) AS SELECT …` runs a
 * query during import.
 */
const checkCreateTable = (s: TokenizedStatement, refuse: Refuse): void => {
  const open = s.tokens.findIndex((t) => depthDelta(t) > 0);
  const head = s.tokens.slice(2, open < 0 ? undefined : open);
  if (
    open < 0 ||
    !head.every((t) => t.type !== TOKEN.KEYWORD && depthDelta(t) === 0)
  ) refuse("schema.sql", s.text, "CREATE TABLE … AS");
  let depth = 0;
  for (let k = open; k < s.tokens.length; k++) {
    depth += depthDelta(s.tokens[k]);
    if (depth === 0) {
      if (k !== s.tokens.length - 1) {
        refuse("schema.sql", s.text, "CREATE TABLE … AS");
      }
      return;
    }
  }
  refuse("schema.sql", s.text, "an unbalanced CREATE TABLE");
};

/**
 * `CREATE TYPE … AS ENUM ( 'a', 'b', … )` may hold only string literals and
 * commas (no `SELECT`, `VALUES` or `FROM` query feeding the enum); any other
 * type definition may not contain a query keyword at all.
 */
const checkCreateType = (s: TokenizedStatement, refuse: Refuse): void => {
  const words = s.tokens.map(wordOf);
  const enumAt = words.indexOf("ENUM");
  if (enumAt < 0) {
    if (
      s.tokens.some((t) =>
        t.type === TOKEN.KEYWORD &&
        ["SELECT", "FROM", "VALUES", "WITH", "TABLE"].includes(wordOf(t))
      )
    ) refuse("schema.sql", s.text, "a query-backed type");
    return;
  }
  const body = s.tokens.slice(enumAt + 1);
  const inner = body.slice(1, -1);
  const ok = body.length >= 2 && body[0].text === "(" &&
    body[body.length - 1].text === ")" &&
    (inner.length === 0 || inner.length % 2 === 1) &&
    inner.every((t, k) =>
      k % 2 === 0 ? t.type === TOKEN.STRING : t.text === ","
    );
  if (!ok) refuse("schema.sql", s.text, "a query-backed type");
};

/**
 * An import image runs its schema.sql and load.sql through IMPORT DATABASE,
 * outside `execute`'s guards, so both are checked against the shapes
 * EXPORT DATABASE produces: schema.sql holds only CREATE statements
 * (no CREATE TABLE … AS, no query-backed ENUM), and load.sql only
 * `COPY <table> FROM '<dir>/<listed parquet file>' (FORMAT 'parquet')`.
 * Anything else (ATTACH, SET, PRAGMA, …) is refused before anything runs.
 */
const validateImage = async (
  db: AsyncDuckDB,
  manifest: Manifest,
  files: readonly Uint8Array[],
): Promise<void> => {
  const text = (name: string) =>
    decoder.decode(files[manifest.files.findIndex((f) => f.name === name)]);
  const refuse: Refuse = (file, statement, why) => {
    throw new Error(
      `refused DuckDB export image: ${file} contains ${why}: ${
        statement.trim().slice(0, 120)
      }`,
    );
  };
  for (const s of await tokenizeScript(db, text("schema.sql"))) {
    const words = s.tokens.map(wordOf);
    const kind = words[1] === "UNIQUE" ? words[2] : words[1];
    if (words[0] !== "CREATE" || !SCHEMA_CREATES.has(words[1])) {
      refuse("schema.sql", s.text, "a statement other than CREATE");
    }
    const denied = s.tokens.find((t) =>
      t.type === TOKEN.KEYWORD && SCHEMA_DENIED.has(wordOf(t))
    );
    if (denied) refuse("schema.sql", s.text, `"${denied.text}"`);
    guard(s.tokens);
    if (kind === "TABLE") checkCreateTable(s, refuse);
    if (kind === "TYPE") checkCreateType(s, refuse);
  }
  const parquet = new Set(
    manifest.files.filter((f) => f.name.endsWith(".parquet")).map((f) =>
      `${manifest.dir}/${f.name}`
    ),
  );
  const copy = new RegExp(
    String
      .raw`^COPY\s+${IDENT}(?:\.${IDENT})?\s+FROM\s+'([^']*)'\s+\(FORMAT\s+'parquet'\)$`,
  );
  for (const s of await tokenizeScript(db, text("load.sql"))) {
    const path = copy.exec(s.text.trim())?.[1];
    if (path === undefined || !parquet.has(path)) {
      refuse(
        "load.sql",
        s.text,
        "a statement other than COPY <table> FROM a listed parquet file",
      );
    }
  }
};

/** The one CHECKPOINT failure that is not an error for us (see checkpoint). */
const OTHER_WRITERS =
  /Cannot CHECKPOINT: there are other write transactions active/;

let exportCounter = 0;

// ---- the service ----------------------------------------------------------------

export const make = (
  opts: DuckDbServiceOptions,
): Effect.Effect<DatabaseService, DatabaseError, Scope.Scope> =>
  Effect.gen(function* () {
    const maxRowsDefault = opts.maxRows ?? DEFAULT_MAX_ROWS;
    const lock = yield* Semaphore.make(1);
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<DatabaseChange>(),
      PubSub.shutdown,
    );
    const engine: DuckDbEngine = yield* Effect.acquireRelease(
      call("open", () => startDuckDb(opts)),
      (e) =>
        Effect.promise(() => e.terminate()).pipe(
          Effect.tap(() => Effect.sync(() => opts.onDispose?.())),
        ),
    );
    const { db } = engine;
    const opfs = engine.persistence.actual === "opfs";
    const states = new WeakMap<AsyncDuckDBConnection, ConnState>();
    const stateOf = (conn: AsyncDuckDBConnection): ConnState => {
      let state = states.get(conn);
      if (!state) {
        state = { inTransaction: false, prepared: new Map() };
        states.set(conn, state);
      }
      return state;
    };
    /**
     * With OPFS, persists committed writes (an unchecked write is lost on
     * reload). Skipped while the app connection is inside an explicit
     * transaction: a CHECKPOINT there would abort it; the COMMIT checkpoints.
     * The only error ignored is another connection (the shell) holding an
     * open write transaction; its commit is checkpointed by publishExternal.
     * Every other failure is thrown.
     */
    const checkpoint = async (conn?: AsyncDuckDBConnection) => {
      if (!opfs || (conn && stateOf(conn).inTransaction)) return;
      const c = conn ?? await db.connect();
      try {
        await opts.onCheckpoint?.();
        await c.query("CHECKPOINT");
      } catch (e) {
        if (!OTHER_WRITERS.test(describe(e))) {
          throw new Error(`CHECKPOINT failed: ${describe(e)}`, { cause: e });
        }
      } finally {
        if (!conn) await c.close();
      }
    };

    const connect = () => call("open", () => db.connect());
    const closeConn = (conn: AsyncDuckDBConnection) =>
      call("open", async () => {
        try {
          await conn.close();
        } finally {
          opts.onClose?.();
        }
      });

    const initialize = (
      conn: AsyncDuckDBConnection,
      operation: DatabaseOperation,
    ) =>
      call(operation, async () => {
        if (Number(await scalar(conn, USER_OBJECTS_SQL)) !== 0) return;
        await transaction(conn, async () => {
          await conn.query(opts.schema);
          await conn.query(opts.seed);
        });
        await checkpoint(conn);
      });

    // The service object never changes; only the app connection in this Ref.
    const current = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const conn = yield* connect();
        yield* initialize(conn, "open").pipe(
          Effect.tapError(() => closeConn(conn).pipe(Effect.ignore)),
        );
        return yield* Ref.make<AsyncDuckDBConnection | undefined>(conn);
      }),
      (ref) =>
        Effect.gen(function* () {
          const conn = yield* Ref.getAndSet(ref, undefined);
          if (conn) yield* closeConn(conn).pipe(Effect.ignore);
        }),
    );

    const withConnection = <A>(
      operation: DatabaseOperation,
      f: (conn: AsyncDuckDBConnection) => Promise<A>,
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
      const maxRows = options?.maxRows ?? maxRowsDefault;
      return withConnection("execute", async (conn) => {
        const state = stateOf(conn);
        const statements = await splitScript(db, sql, state);
        let raw: Raw;
        try {
          raw = await runScript(conn, state, statements, maxRows);
        } catch (e) {
          if (e instanceof ExecFailure && isWrite(e.partial)) {
            try {
              await checkpoint(conn);
            } catch (c) {
              throw new ExecFailure(
                e.original,
                e.partial,
                `${e.message}; the applied part is not persisted: ${
                  describe(c)
                }`,
              );
            }
          }
          throw e;
        }
        if (raw.wrote || raw.uncounted) {
          try {
            await checkpoint(conn);
          } catch (c) {
            // Applied in memory but not persisted: publish, then fail.
            throw new ExecFailure(
              c,
              raw,
              `write applied but not persisted: ${describe(c)}`,
            );
          }
        }
        return raw;
      }).pipe(
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
        Effect.map((r): QueryResult => ({
          columns: r.columns,
          rows: r.rows,
          changes: r.changes,
          schemaChanged: r.schemaChanged,
          truncated: r.truncated,
        })),
        Effect.tapError((e) => {
          const failure = e.cause;
          return failure instanceof ExecFailure && isWrite(failure.partial)
            ? publish({
              kind: "write",
              source,
              changes: failure.partial.changes,
              schemaChanged: failure.partial.schemaChanged,
            })
            : Effect.void;
        }),
        Effect.mapError((e) =>
          e.cause instanceof ExecFailure
            ? new DatabaseError({
              operation: "execute",
              message: e.message,
              cause: e.cause.original,
            })
            : e
        ),
        lock.withPermit,
      );
    };

    /**
     * Close the app connection, open a new one, replace the catalog. Callers
     * hold the permit.
     */
    const swapUnlocked = (
      operation: "reset" | "import",
      replace: (conn: AsyncDuckDBConnection) => Promise<void>,
    ) =>
      Effect.gen(function* () {
        const old = yield* Ref.getAndSet(current, undefined);
        if (old) yield* closeConn(old);
        const conn = yield* connect();
        yield* Ref.set(current, conn);
        yield* call(operation, () =>
          transaction(conn, async () => {
            const drops = await dropAllSql(conn);
            if (drops) await conn.query(drops);
            await replace(conn);
          }));
        yield* publish({
          kind: operation,
          source: "host",
          changes: 0,
          schemaChanged: true,
        });
        yield* call(operation, () => checkpoint(conn));
      });

    const exportBytes = () =>
      // A fresh connection: the image holds committed data only, even when
      // the app connection is inside an explicit transaction.
      withConnection("export", async () => {
        const dir = `__prototyper_export_${Date.now().toString(36)}_${
          (exportCounter++).toString(36)
        }`;
        const names: string[] = [];
        const files: Uint8Array[] = [];
        const conn = await db.connect();
        try {
          await conn.query(
            `EXPORT DATABASE ${sqlString(dir)} (FORMAT parquet)`,
          );
          for (const f of await db.globFiles(`${dir}/*`)) {
            names.push(f.fileName.slice(dir.length + 1));
            files.push(await db.copyFileToBuffer(f.fileName));
          }
        } finally {
          // Also after a partial EXPORT: never leave buffer files behind.
          const left = await db.globFiles(`${dir}/*`).catch(() => []);
          await db.dropFiles(left.map((f) => f.fileName)).catch(() => null);
          await conn.close();
        }
        return packExport({
          engine: "duckdb",
          version: engine.version,
          dir,
          files: names.map((name, k) => ({ name, size: files[k].length })),
        }, files);
      }).pipe(lock.withPermit);

    const importBytes = (bytes: Uint8Array) =>
      Effect.gen(function* () {
        const { manifest, files } = yield* Effect.try({
          try: () => unpackExport(bytes),
          catch: toDatabaseError("import"),
        });
        // Only DuckDB's own EXPORT shapes may run (Q12/Q17); checked before
        // any file is registered or any statement runs.
        yield* call("import", () => validateImage(db, manifest, files));
        const paths = manifest.files.map((f) => `${manifest.dir}/${f.name}`);
        yield* Effect.acquireUseRelease(
          call("import", async () => {
            await db.dropFiles(paths).catch(() => undefined);
            try {
              for (const [k, path] of paths.entries()) {
                // registerFileBuffer transfers the buffer: hand over copies.
                await db.registerFileBuffer(path, files[k].slice());
              }
            } catch (e) {
              await db.dropFiles(paths).catch(() => undefined);
              throw e;
            }
          }),
          () =>
            swapUnlocked("import", async (conn) => {
              await conn.query(`IMPORT DATABASE ${sqlString(manifest.dir)}`);
            }),
          () =>
            Effect.promise(() => db.dropFiles(paths).catch(() => undefined)),
        );
      }).pipe(lock.withPermit);

    const service: DatabaseService = {
      engine: "duckdb",
      version: engine.version,
      persistence: engine.persistence,
      capabilities: {
        persistence: opfs ? { available: true } : {
          available: false,
          reason: engine.persistence.reason ?? "memory requested",
        },
        multiTab: {
          available: false,
          reason: "one OPFS access handle per database file (plan.md Q15)",
        },
        export: { available: true },
        import: { available: true },
        cancellation: {
          available: false,
          reason: "statement cancellation is not wired into the service",
        },
      },
      execute,
      tables: () =>
        withConnection("tables", async (conn) =>
          (await rowsOf(
            conn,
            `SELECT CASE WHEN schema_name = 'main' THEN table_name ELSE schema_name || '.' || table_name END AS name
             FROM duckdb_tables() WHERE database_name = current_database()
             ORDER BY schema_name <> 'main', schema_name, table_name`,
          )).map((r) => String(r.name))).pipe(lock.withPermit),
      schema: (table) =>
        withConnection("schema", async (conn) => {
          const dot = table.indexOf(".");
          const [schemaName, name] = dot < 0
            ? ["main", table]
            : [table.slice(0, dot), table.slice(dot + 1)];
          const rows = await rowsOf(
            conn,
            `SELECT sql FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = ${
              sqlString(schemaName)
            } AND table_name = ${sqlString(name)}`,
          );
          if (rows.length === 0) throw new Error(`no such table: ${table}`);
          return String(rows[0].sql);
        }).pipe(lock.withPermit),
      reset: () =>
        swapUnlocked("reset", async (conn) => {
          await conn.query(opts.schema);
          await conn.query(opts.seed);
        }).pipe(lock.withPermit),
      exportBytes,
      importBytes,
      subscribe: PubSub.subscribe(pubsub),
      changes: Stream.fromPubSub(pubsub),
    };

    const handle: DuckDbHandle = {
      db,
      path: engine.path,
      resolveDatabase: () => Promise.resolve(db),
      // Runs outside the permit (open item for DB1): the shell writes on
      // its own connection, so only CHECKPOINT and the event happen here.
      publishExternal: async (change) => {
        if (!isWrite(change)) return;
        await Effect.runPromise(publish(change));
        await checkpoint();
      },
    };
    handles.set(service, handle);
    return service;
  });

/** Scoped layer: the finalizer closes the connection and the worker. */
export const layer = (
  opts: DuckDbServiceOptions,
): Layer.Layer<Database, DatabaseError> => Layer.effect(Database)(make(opts));
