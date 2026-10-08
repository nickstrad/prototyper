// D1's ten conformance cases (conformance.ts) in DuckDB's dialect, plus the
// DuckDB-specific checks D2 is accepted on. D1's suite itself is SQLite-bound
// (engine "sqlite", a 3.x version, "SQLite format 3" export header, SQLite
// error texts, typeof() = 'integer', untyped columns, rowid) and is frozen;
// it is run unchanged against this service too (duckdb-harness.ts) and its
// SQLite-only expectations are reported, not hidden. Each case below keeps
// D1's name and behaviour and changes only what the dialect forces:
// sequence-backed ids, typed columns, DuckDB error texts, `count_star()`, the
// `PROTOTYPER-DUCKDB-EXPORT` image.
//
// Runtime-neutral like D1's suite: no Deno or DOM APIs, no test framework.
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Scope,
  Stream,
} from "effect";
import type { Cell, DatabaseChange, DatabaseService } from "../core/types.ts";
import {
  canonical,
  type ConformanceCase,
  type ConformanceOutcome,
  type ConformanceTarget,
} from "./conformance.ts";
import { decodeCell, encodeCell } from "./sqlite-cells.ts";
import { Database } from "./sqlite-service.ts";
import { TASKS_SEED_ROWS } from "./duckdb-seed.ts";
import { DUCKDB_EXPORT_MAGIC } from "./duckdb-service.ts";

// ---- assertions (as conformance.ts) ----------------------------------------

class ConformanceFailure extends Error {}

const check = (condition: unknown, message: string): void => {
  if (!condition) throw new ConformanceFailure(message);
};

const same = (actual: unknown, expected: unknown, message: string): void => {
  const a = canonical(actual);
  const e = canonical(expected);
  if (a !== e) {
    throw new ConformanceFailure(
      `${message}\n  actual:   ${a}\n  expected: ${e}`,
    );
  }
};

// ---- harness (as conformance.ts) ---------------------------------------------

type Counts = { closes: number; disposes: number };

const withService = async <A>(
  target: ConformanceTarget,
  body: (
    db: DatabaseService,
    counts: Counts,
  ) => Effect.Effect<A, unknown, Scope.Scope | Database>,
): Promise<{ result: A; counts: Counts }> => {
  const counts: Counts = { closes: 0, disposes: 0 };
  const live = target.layer({
    onClose: () => counts.closes++,
    onDispose: () => counts.disposes++,
  });
  const scope = Effect.runSync(Scope.make());
  let closed = false;
  try {
    const ctx = await Effect.runPromise(
      Layer.build(live).pipe(Scope.provide(scope)),
    );
    const db = Context.get(ctx, Database);
    const result = await Effect.runPromise(
      body(db, counts).pipe(
        Effect.provideService(Database, db),
        Scope.provide(scope),
      ),
    );
    const before = { ...counts };
    await Effect.runPromise(Scope.close(scope, Exit.void));
    closed = true;
    check(
      counts.disposes === 1,
      `finalizer disposed the engine ${counts.disposes} times`,
    );
    check(counts.closes > before.closes, "finalizer closed the connection");
    const after = await Effect.runPromise(Effect.flip(db.execute("SELECT 1")));
    check(after._tag === "DatabaseError", "closed service rejects execute");
    return { result, counts: before };
  } finally {
    if (!closed) await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

const drain = <A>(sub: PubSub.Subscription<A>) => PubSub.takeUpTo(sub, 1000);

const write = (
  changes: number,
  schemaChanged = false,
  source: DatabaseChange["source"] = "app",
): DatabaseChange => ({ kind: "write", source, changes, schemaChanged });

const INSERT = (title: string) =>
  `INSERT INTO tasks (title, created_at) VALUES ('${title}', '2026-02-01T00:00:00.000Z')`;

const TASK_COLUMNS = ["id", "title", "completed", "created_at"];

/** SQL literal for a cell, cast to the column's DuckDB type. */
const literal = (cell: Cell, type: string): string => {
  const value = cell === null
    ? "NULL"
    : cell instanceof Uint8Array
    ? `from_hex('${
      Array.from(cell, (b) => b.toString(16).padStart(2, "0")).join("")
    }')`
    : typeof cell === "string"
    ? `'${cell.replaceAll("'", "''")}'`
    : String(cell);
  return `CAST(${value} AS ${type})`;
};

// ---- the typed round-trip table (acceptance: BIGINT/HUGEINT/DECIMAL/
// INTERVAL/TIMESTAMP/LIST/NULL exactly) ------------------------------------------

const TYPES_DDL = `CREATE TABLE v (
  i BIGINT, big BIGINT, huge HUGEINT, d DECIMAL(18,3), dd DECIMAL(38,10),
  r DOUBLE, f FLOAT, t VARCHAR, b BLOB, bo BOOLEAN, dt DATE, ts TIMESTAMP,
  tstz TIMESTAMPTZ, tns TIMESTAMP_NS, tm TIME, iv INTERVAL, l INTEGER[],
  lb BIGINT[], lv VARCHAR[], st STRUCT(a INTEGER, b VARCHAR),
  m MAP(VARCHAR, INTEGER), u UUID, n INTEGER
)`;

const TYPES_ROWS = `INSERT INTO v VALUES
 (42, 9007199254740993, 170141183460469231731687303715884105727, 3.14,
  -0.0000000001, 1.5, 0.1, 'héllo ☃', '\\x00\\xFF\\x10'::BLOB, true,
  DATE '2024-02-29', TIMESTAMP '2024-01-01 09:00:00.123456',
  TIMESTAMPTZ '2024-01-01 09:00:00.5+00',
  TIMESTAMP_NS '2024-01-01 09:00:00.123456789', TIME '23:59:59.999999',
  INTERVAL '1 year 2 months 3 days 04:05:06.789', [1, 2, NULL],
  [9223372036854775807, NULL], ['a', 'b,c', NULL, '', 'it''s'],
  {'a': 1, 'b': 'x y'}, MAP {'k': 1, 'null': NULL},
  '00000000-0000-0000-0000-000000000001', NULL),
 (9007199254740991, -9223372036854775808,
  -170141183460469231731687303715884105727, -12.345, 0, -0.25, -2.5, '',
  ''::BLOB, false, DATE '1969-12-31', TIMESTAMP '1969-12-31 23:59:59.999999',
  TIMESTAMPTZ '1970-01-01 00:00:00+00', TIMESTAMP_NS '1970-01-01 00:00:00',
  TIME '00:00:00', INTERVAL 90 MINUTE, [], [], [], {'a': NULL, 'b': NULL},
  MAP {}, 'ffffffff-ffff-ffff-ffff-ffffffffffff', NULL),
 (-9007199254740991, 9223372036854775807, 18446744073709551616, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  INTERVAL '-1 day -00:00:01', [NULL], NULL, NULL, NULL, NULL, NULL, NULL)`;

const TYPES_EXPECTED: Cell[][] = [
  [
    42,
    9007199254740993n,
    170141183460469231731687303715884105727n,
    "3.140",
    "-0.0000000001",
    1.5,
    0.1,
    "héllo ☃",
    new Uint8Array([0, 255, 16]),
    1,
    "2024-02-29",
    "2024-01-01 09:00:00.123456",
    "2024-01-01 09:00:00.5+00",
    "2024-01-01 09:00:00.123456789",
    "23:59:59.999999",
    "1 year 2 months 3 days 04:05:06.789",
    "[1, 2, NULL]",
    "[9223372036854775807, NULL]",
    "[a, 'b,c', NULL, '', 'it\\'s']",
    "{'a': 1, 'b': x y}",
    "{k=1, 'null'=NULL}",
    "00000000-0000-0000-0000-000000000001",
    null,
  ],
  [
    9007199254740991,
    -9223372036854775808n,
    -170141183460469231731687303715884105727n,
    "-12.345",
    "0.0000000000",
    -0.25,
    -2.5,
    "",
    new Uint8Array([]),
    0,
    "1969-12-31",
    "1969-12-31 23:59:59.999999",
    "1970-01-01 00:00:00+00",
    "1970-01-01 00:00:00",
    "00:00:00",
    "01:30:00",
    "[]",
    "[]",
    "[]",
    "{'a': NULL, 'b': NULL}",
    "{}",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    null,
  ],
  [
    -9007199254740991,
    9223372036854775807n,
    18446744073709551616n,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "-1 day -00:00:01",
    "[NULL]",
    null,
    null,
    null,
    null,
    null,
    null,
  ],
];

/** Columns whose cells are DuckDB text: must equal CAST(col AS VARCHAR). */
const TEXT_COLUMNS = [
  "d",
  "dd",
  "dt",
  "ts",
  "tstz",
  "tns",
  "tm",
  "iv",
  "l",
  "lb",
  "lv",
  "st",
  "m",
  "u",
];

// ---- cases ---------------------------------------------------------------------

export const duckDbConformanceCases: readonly ConformanceCase[] = [
  {
    name: "seeded service reports identity, tables, schema and seed rows",
    run: async (target) => {
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            return {
              rows: yield* db.execute("SELECT * FROM tasks ORDER BY id"),
              tables: yield* db.tables(),
              schema: yield* db.schema("tasks"),
              db,
            };
          }),
      );
      const { db } = result;
      check(db.engine === "duckdb", `engine ${db.engine}`);
      check(/^1\.\d+\.\d+$/.test(db.version), `version ${db.version}`);
      if (target.expectPersistence) {
        same(
          db.persistence.actual,
          target.expectPersistence,
          "persistence.actual",
        );
      }
      check(db.capabilities.export.available, "export capability");
      check(db.capabilities.import.available, "import capability");
      same(result.rows.columns, TASK_COLUMNS, "columns");
      same(result.rows.rows, TASKS_SEED_ROWS, "seed rows");
      same(result.rows.changes, 0, "select changes");
      same(result.tables, ["tasks"], "tables()");
      check(
        result.schema.startsWith("CREATE TABLE tasks"),
        `schema(): ${result.schema}`,
      );
    },
  },
  {
    name: "bad SQL yields a typed DatabaseError and publishes nothing",
    run: async (target) => {
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            const sub = yield* db.subscribe;
            const syntax = yield* Effect.flip(db.execute("SELEC nope"));
            const missing = yield* Effect.flip(
              db.execute("SELECT * FROM nope"),
            );
            const noTable = yield* Effect.flip(db.schema("nope"));
            const caught = yield* db.execute("SELEC nope").pipe(
              Effect.catchTag(
                "DatabaseError",
                (e) => Effect.succeed(`caught:${e.operation}`),
              ),
            );
            // Q12/Q17: the service never opens another path.
            const attach = yield* Effect.flip(
              db.execute("SELECT 1; ATTACH 'other.duckdb' AS other"),
            );
            const opfs = yield* Effect.flip(
              db.execute("COPY tasks TO 'opfs://elsewhere.csv'"),
            );
            const usable = yield* db.execute("SELECT count(*) FROM tasks");
            return {
              syntax,
              missing,
              noTable,
              caught,
              attach,
              opfs,
              usable,
              events: yield* drain(sub),
            };
          }),
      );
      same(result.syntax._tag, "DatabaseError", "syntax _tag");
      same(result.syntax.operation, "execute", "syntax operation");
      check(/syntax error/.test(result.syntax.message), result.syntax.message);
      check(
        /Table with name nope does not exist/.test(result.missing.message),
        result.missing.message,
      );
      same(result.noTable.operation, "schema", "schema() operation");
      same(result.caught, "caught:execute", "catchTag");
      check(/ATTACH is blocked/.test(result.attach.message), "ATTACH blocked");
      check(/opfs:\/\/ paths are blocked/.test(result.opfs.message), "opfs");
      same(result.usable.rows, [[3]], "still usable");
      same(result.events, [], "no events");
    },
  },
  {
    name: "exactly one change event per successful write, none otherwise",
    run: async (target) => {
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            const sub = yield* db.subscribe;
            const ins = yield* db.execute(INSERT("a"));
            const sel = yield* db.execute("SELECT * FROM tasks"); // read
            yield* db.execute("UPDATE tasks SET completed = 1 WHERE id = 999"); // no-op
            yield* Effect.flip(
              db.execute("INSERT INTO tasks (title) VALUES ('x')"),
            ); // NOT NULL
            const upd = yield* db.execute("UPDATE tasks SET completed = 1"); // 4 rows
            yield* db.execute("CREATE INDEX tasks_title ON tasks(title)"); // DDL
            yield* db.execute("DELETE FROM tasks WHERE id = 4", {
              source: "host",
            });
            const after = yield* db.execute("SELECT count(*) AS n FROM tasks");
            return { ins, sel, upd, after, events: yield* drain(sub) };
          }),
      );
      same(result.ins.changes, 1, "insert changes");
      same(result.sel.changes, 0, "select after insert: changes not sticky");
      same(result.upd.changes, 4, "update changes");
      same(result.after.changes, 0, "count changes");
      same(result.events, [
        write(1),
        write(4),
        write(0, true),
        write(1, false, "host"),
      ], "events");
    },
  },
  {
    name: "a script failing partway publishes one write for the applied part",
    run: async (target) => {
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            const sub = yield* db.subscribe;
            const err = yield* Effect.flip(
              db.execute(`${INSERT("first")}; INSERT INTO nope VALUES (1);`),
            );
            const rows = yield* db.execute("SELECT count(*) FROM tasks");
            return { err, rows, events: yield* drain(sub) };
          }),
      );
      same(result.err.operation, "execute", "operation");
      check(
        /Table with name nope does not exist/.test(result.err.message),
        result.err.message,
      );
      same(result.rows.rows, [[4]], "first statement stayed applied");
      same(result.events, [write(1)], "one write event (plan §9)");
    },
  },
  {
    name: "reset restores exact seeds with the same service identity",
    run: async (target) => {
      const { result, counts } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            const before = yield* Database;
            const sub = yield* db.subscribe;
            yield* db.execute(`DELETE FROM tasks; ${INSERT("only")};`);
            yield* db.execute("CREATE TABLE extra (x INTEGER)");
            yield* db.reset();
            const after = yield* Database;
            return {
              same: before === after && after === db,
              rows: yield* after.execute("SELECT * FROM tasks ORDER BY id"),
              tables: yield* after.tables(),
              next: yield* after.execute(`${INSERT("next")} RETURNING id`),
              events: yield* drain(sub),
            };
          }),
      );
      check(result.same, "service identity changed across reset");
      same(result.rows.rows, TASKS_SEED_ROWS, "seed rows after reset");
      same(result.tables, ["tasks"], "tables after reset");
      same(result.next.rows, [[4]], "sequence restarted with the seeds");
      same(result.events, [
        write(4),
        write(0, true),
        { kind: "reset", source: "host", changes: 0, schemaChanged: true },
        write(1),
      ], "events");
      same(counts.closes, 1, "reset closed the old connection exactly once");
      same(counts.disposes, 0, "reset kept the engine");
    },
  },
  {
    name:
      "export/import round-trip; bad and corrupt images restore the snapshot",
    run: async (target) => {
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            yield* db.execute(INSERT("exported"));
            const bytes = yield* db.exportBytes();
            yield* db.reset();
            const afterReset = yield* db.execute("SELECT count(*) FROM tasks");
            const sub = yield* db.subscribe;
            yield* db.importBytes(bytes);
            const imported = yield* drain(sub);
            const afterImport = yield* db.execute(
              "SELECT title FROM tasks ORDER BY id DESC LIMIT 1",
            );
            const bad = yield* Effect.flip(
              db.importBytes(new TextEncoder().encode("not a database")),
            );
            const stillUsable = yield* db.execute("SELECT count(*) FROM tasks");
            // Valid header and manifest, garbage table data.
            const corrupt = bytes.slice();
            corrupt.fill(0xab, corrupt.length - 64);
            const corruptErr = yield* Effect.flip(db.importBytes(corrupt));
            const restored = yield* db.execute("SELECT count(*) FROM tasks");
            const next = yield* db.execute(`${INSERT("after")} RETURNING id`);
            return {
              header: new TextDecoder().decode(
                bytes.subarray(0, DUCKDB_EXPORT_MAGIC.length),
              ),
              afterReset,
              imported,
              afterImport,
              bad,
              stillUsable,
              corruptErr,
              restored,
              next,
              failedEvents: yield* drain(sub),
            };
          }),
      );
      same(result.header, DUCKDB_EXPORT_MAGIC, "export header");
      same(result.afterReset.rows, [[3]], "reset");
      same(result.imported, [
        { kind: "import", source: "host", changes: 0, schemaChanged: true },
      ], "import event");
      same(result.afterImport.rows, [["exported"]], "imported data");
      same(result.bad.operation, "import", "bad header operation");
      same(
        result.stillUsable.rows,
        [[4]],
        "bad header rejected before touching data",
      );
      same(result.corruptErr.operation, "import", "corrupt operation");
      same(result.restored.rows, [[4]], "corrupt import restored the snapshot");
      same(result.next.rows, [[5]], "imported sequence continues");
      same(result.failedEvents, [write(1)], "failed imports publish nothing");
    },
  },
  {
    name: "bigint, null, blob, text and real cells round-trip",
    run: async (target) => {
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            yield* db.execute(`${TYPES_DDL}; ${TYPES_ROWS}`);
            const first = yield* db.execute("SELECT * FROM v ORDER BY rowid");
            const types = (yield* db.execute("DESCRIBE v")).rows.map((r) =>
              String(r[1])
            );
            const text = yield* db.execute(
              `SELECT ${
                TEXT_COLUMNS.map((c) => `CAST(${c} AS VARCHAR)`).join(", ")
              } FROM v ORDER BY rowid`,
            );
            // Write the read cells back as typed SQL literals, read again.
            yield* db.execute("CREATE TABLE w AS SELECT * FROM v WHERE false");
            for (const row of first.rows) {
              yield* db.execute(
                `INSERT INTO w VALUES (${
                  row.map((c, k) => literal(c, types[k])).join(", ")
                })`,
              );
            }
            const second = yield* db.execute("SELECT * FROM w ORDER BY rowid");
            const equal = yield* db.execute(
              "SELECT count(*) FROM (SELECT * REPLACE (m::VARCHAR AS m) FROM v EXCEPT ALL SELECT * REPLACE (m::VARCHAR AS m) FROM w)",
            );
            const exprs = yield* db.execute(
              "SELECT 1 = 1 AS t, 2 > 3 AS f, typeof(9007199254740993) AS ty, 2.0::DOUBLE AS two, 2.0 AS dec2, [1.5, 2.0]::DOUBLE[] AS dl",
            );
            return { first, second, text, equal, exprs };
          }),
      );
      same(result.first.rows, TYPES_EXPECTED, "normalized cells");
      const [row] = result.first.rows;
      check(typeof row[0] === "number", "safe integer is a number");
      check(typeof row[1] === "bigint", "unsafe BIGINT is a bigint");
      check(typeof row[2] === "bigint", "HUGEINT is a bigint");
      check(row[8] instanceof Uint8Array, "blob is a Uint8Array");
      const columns = result.first.columns;
      same(
        result.first.rows.map((r) =>
          TEXT_COLUMNS.map((c) => r[columns.indexOf(c)])
        ),
        result.text.rows,
        "text cells equal CAST(... AS VARCHAR)",
      );
      same(result.second.rows, TYPES_EXPECTED, "cells written back as SQL");
      same(result.equal.rows, [[0]], "written-back table equals the original");
      same(
        result.exprs.rows,
        [[1, 0, "BIGINT", 2, "2.0", "[1.5, 2.0]"]],
        "booleans, reals and decimals",
      );
      const encoded = row.slice(0, 9).map(encodeCell);
      same(encoded, [
        42,
        { $type: "bigint", value: "9007199254740993" },
        { $type: "bigint", value: "170141183460469231731687303715884105727" },
        "3.140",
        "-0.0000000001",
        1.5,
        0.1,
        "héllo ☃",
        { $type: "blob", base64: "AP8Q" },
      ], "encodeCell JSON form");
      same(
        JSON.parse(JSON.stringify(row.map(encodeCell))).map(decodeCell),
        row,
        "encodeCell -> JSON -> decodeCell",
      );
    },
  },
  {
    name: "result shapes: duplicates, first result set, comments, truncation",
    run: async (target) => {
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            return {
              dup: yield* db.execute(
                "SELECT 1 AS a, 2 AS a, count(*) FROM tasks",
              ),
              multi: yield* db.execute(
                `${
                  INSERT("m")
                }; SELECT count(*) AS c FROM tasks; SELECT 'second'`,
              ),
              comment: yield* db.execute("-- comment only\n"),
              empty: yield* db.execute("SELECT * FROM tasks WHERE 0"),
              truncated: yield* db.execute("SELECT id FROM tasks ORDER BY id", {
                maxRows: 2,
              }),
              whole: yield* db.execute("SELECT id FROM tasks ORDER BY id"),
              split: yield* db.execute(
                "-- a; comment\nSELECT 'a;b' AS \"x;y\", 'héllo ☃;' AS h /* ; */; SELECT 2",
              ),
            };
          }),
      );
      same(
        result.dup.columns,
        ["a", "a", "count_star()"],
        "duplicate column names",
      );
      same(result.dup.rows, [[1, 2, 3]], "duplicate rows");
      same(result.multi.columns, ["c"], "first result set columns");
      same(result.multi.rows, [[4]], "first result set rows");
      same(result.multi.changes, 1, "changes across the script");
      same(
        [result.comment.columns, result.comment.rows, result.comment.changes],
        [[], [], 0],
        "comment-only script",
      );
      same(result.empty.columns, TASK_COLUMNS, "empty result columns");
      same(result.empty.rows, [], "empty result rows");
      same(result.truncated.rows, [[1], [2]], "truncated rows");
      check(result.truncated.truncated, "truncated flag");
      check(!result.whole.truncated, "untruncated flag");
      same(
        [result.split.columns, result.split.rows],
        [["x;y", "h"], [["a;b", "héllo ☃;"]]],
        "split by DuckDB's tokenizer (strings, identifiers, comments, UTF-8)",
      );
    },
  },
  {
    name: "execute, reset and import are serialized",
    run: async (target) => {
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            yield* db.execute(INSERT("before reset"));
            const bytes = yield* db.exportBytes(); // 4 rows
            const work = [
              db.reset(),
              ...[1, 2, 3].map((n) => db.execute(INSERT(`after reset ${n}`))),
              db.importBytes(bytes),
              ...[4, 5].map((n) => db.execute(INSERT(`after import ${n}`))),
              db.execute("SELECT count(*) FROM tasks"),
            ];
            const results = yield* Effect.all(work, {
              concurrency: "unbounded",
            });
            const titles = yield* db.execute(
              "SELECT title FROM tasks ORDER BY id",
            );
            return { last: results[results.length - 1], titles };
          }),
      );
      same(result.last, {
        columns: ["count_star()"],
        rows: [[6]],
        changes: 0,
        schemaChanged: false,
        truncated: false,
      }, "count after reset, 3 inserts, import, 2 inserts (in order)");
      same(result.titles.rows.map((r) => r[0]), [
        "Write the project plan",
        "Probe SQLite WASM",
        "Wire the terminal",
        "before reset",
        "after import 4",
        "after import 5",
      ], "operations ran one at a time in submission order");
    },
  },
  {
    name: "changes stream delivers events in order",
    run: async (target) => {
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            const fiber = yield* db.changes.pipe(
              Stream.take(3),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Effect.yieldNow; // let the stream subscribe first
            yield* Effect.sleep(10);
            yield* db.execute(INSERT("s"));
            yield* db.execute("SELECT 1"); // no event
            yield* db.reset();
            yield* db.execute("DROP TABLE tasks");
            return yield* Fiber.join(fiber);
          }),
      );
      same(
        Array.from(result).map((e) => e.kind),
        ["write", "reset", "write"],
        "kinds",
      );
      same(Array.from(result)[2], write(0, true), "drop event");
    },
  },
  {
    name: "catalog diff: every kind of DDL is schemaChanged, reads are not",
    run: async (target) => {
      const ddl = [
        "CREATE VIEW open_tasks AS SELECT * FROM tasks WHERE completed = 0",
        "CREATE MACRO twice(x) AS x * 2",
        "CREATE SEQUENCE extra_seq",
        "CREATE TYPE mood AS ENUM ('ok', 'sad')",
        "CREATE SCHEMA side",
        "CREATE TABLE side.t (x INTEGER)",
        "ALTER TABLE tasks ADD COLUMN note VARCHAR",
        "CREATE TEMP TABLE scratch (x INTEGER)",
        "DROP VIEW open_tasks",
      ];
      const reads = [
        "SELECT twice(21)",
        "SELECT nextval('extra_seq')",
        "SHOW TABLES",
        "DESCRIBE tasks",
        "PRAGMA table_info('tasks')",
        "SELECT to_json({'a': 1}) AS j",
      ];
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            const out: [string, boolean, number][] = [];
            for (const sql of [...ddl, ...reads]) {
              const r = yield* db.execute(sql);
              out.push([sql, r.schemaChanged, r.changes]);
            }
            return { out, tables: yield* db.tables() };
          }),
      );
      same(
        result.out,
        [
          ...ddl.map((sql): [string, boolean, number] => [sql, true, 0]),
          ...reads.map((sql): [string, boolean, number] => [sql, false, 0]),
        ],
        "schemaChanged per statement",
      );
      same(result.tables, ["tasks", "side.t"], "tables() lists other schemas");
    },
  },
];

/** Runs every case (or those whose name contains `filter`) sequentially. */
export const runDuckDbConformance = async (
  target: ConformanceTarget,
  filter = "",
): Promise<ConformanceOutcome[]> => {
  const outcomes: ConformanceOutcome[] = [];
  for (const c of duckDbConformanceCases) {
    if (!c.name.includes(filter)) continue;
    const start = performance.now();
    try {
      await c.run(target);
      outcomes.push({
        name: c.name,
        ok: true,
        ms: Math.round(performance.now() - start),
      });
    } catch (e) {
      outcomes.push({
        name: c.name,
        ok: false,
        ms: Math.round(performance.now() - start),
        error: e instanceof Error
          ? `${e.message}\n${e.stack ?? ""}`
          : String(e),
      });
    }
  }
  return outcomes;
};
