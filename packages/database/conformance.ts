// Conformance suite for every SQLite DatabaseService implementation (plan.md
// §9): the Fiddle engine in the browser, node:sqlite and sqlite-wasm memory
// under Deno. Runtime-neutral on purpose (no Deno or DOM APIs, no test
// framework): Deno tests register one Deno.test per case, and the browser
// runs the same cases in the page through the playground hooks.
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
import type {
  Cell,
  DatabaseChange,
  DatabaseService,
  Persistence,
} from "../core/types.ts";
import { decodeCell, encodeCell } from "./sqlite-cells.ts";
import { Database, type DatabaseError } from "./sqlite-service.ts";
import { TASKS_SEED_ROWS } from "./sqlite-seed.ts";

/** Counters the target's backend reports through its test hooks. */
export type ConformanceHooks = {
  readonly onClose: () => void;
  readonly onDispose: () => void;
};

export type ConformanceTarget = {
  readonly name: string;
  /** A fresh database seeded with the tasks schema (sqlite-seed.ts). */
  readonly layer: (hooks: ConformanceHooks) => Layer.Layer<
    Database,
    DatabaseError
  >;
  readonly expectPersistence?: Persistence;
};

export type ConformanceCase = {
  readonly name: string;
  readonly run: (target: ConformanceTarget) => Promise<void>;
};

export type ConformanceOutcome = {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly error?: string;
};

// ---- assertions -------------------------------------------------------------

class ConformanceFailure extends Error {}

/** Stable text for deep comparison; bigint and bytes stay distinguishable. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return `bigint:${v}`;
    if (v instanceof Uint8Array) return `bytes:${Array.from(v).join(",")}`;
    return v;
  });

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

// ---- harness ---------------------------------------------------------------

type Counts = { closes: number; disposes: number };

/**
 * Builds the target's layer in an explicit scope, runs `body`, closes the
 * scope, and checks the finalizer: exactly one engine disposal and at least
 * one connection close; afterwards the service rejects work.
 */
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

// ---- cases -------------------------------------------------------------------

export const conformanceCases: readonly ConformanceCase[] = [
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
      check(db.engine === "sqlite", `engine ${db.engine}`);
      check(/^3\.\d+\.\d+$/.test(db.version), `version ${db.version}`);
      if (target.expectPersistence) {
        same(
          db.persistence.actual,
          target.expectPersistence,
          "persistence.actual",
        );
      }
      check(db.capabilities.export.available, "export capability");
      check(db.capabilities.import.available, "import capability");
      same(
        result.rows.columns,
        ["id", "title", "completed", "created_at"],
        "columns",
      );
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
            const usable = yield* db.execute("SELECT count(*) FROM tasks");
            return {
              syntax,
              missing,
              noTable,
              caught,
              usable,
              events: yield* drain(sub),
            };
          }),
      );
      same(result.syntax._tag, "DatabaseError", "syntax _tag");
      same(result.syntax.operation, "execute", "syntax operation");
      check(/syntax error/.test(result.syntax.message), result.syntax.message);
      check(
        /no such table/.test(result.missing.message),
        result.missing.message,
      );
      same(result.noTable.operation, "schema", "schema() operation");
      same(result.caught, "caught:execute", "catchTag");
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
      check(/no such table/.test(result.err.message), result.err.message);
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
            yield* db.execute("CREATE TABLE extra (x)");
            yield* db.reset();
            const after = yield* Database;
            return {
              same: before === after && after === db,
              rows: yield* after.execute("SELECT * FROM tasks ORDER BY id"),
              tables: yield* after.tables(),
              events: yield* drain(sub),
            };
          }),
      );
      check(result.same, "service identity changed across reset");
      same(result.rows.rows, TASKS_SEED_ROWS, "seed rows after reset");
      same(result.tables, ["tasks"], "tables after reset");
      same(result.events, [
        write(4),
        write(0, true),
        { kind: "reset", source: "host", changes: 0, schemaChanged: true },
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
            const corrupt = bytes.slice();
            corrupt.fill(0xab, 100); // valid header, garbage pages
            const corruptErr = yield* Effect.flip(db.importBytes(corrupt));
            const restored = yield* db.execute("SELECT count(*) FROM tasks");
            return {
              header: new TextDecoder().decode(bytes.subarray(0, 15)),
              afterReset,
              imported,
              afterImport,
              bad,
              stillUsable,
              corruptErr,
              restored,
              failedEvents: yield* drain(sub),
            };
          }),
      );
      same(result.header, "SQLite format 3", "export header");
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
      same(result.failedEvents, [], "failed imports publish nothing");
    },
  },
  {
    name: "bigint, null, blob, text and real cells round-trip",
    run: async (target) => {
      const { result } = await withService(
        target,
        (db) =>
          Effect.gen(function* () {
            yield* db.execute(
              "CREATE TABLE v (i INTEGER, big INTEGER, t TEXT, b BLOB, r REAL, n);" +
                "INSERT INTO v VALUES (42, 9007199254740993, 'héllo ☃', x'00ff10', 1.5, NULL);" +
                "INSERT INTO v VALUES (9007199254740991, -9223372036854775808, '', x'', -0.25, NULL);" +
                "INSERT INTO v VALUES (-9007199254740991, 9223372036854775807, 'x', x'7f', 2.0, NULL);",
            );
            const first = yield* db.execute("SELECT * FROM v ORDER BY rowid");
            // Write the read cells back as SQL literals and read them again.
            const literal = (c: Cell): string =>
              c === null
                ? "NULL"
                : c instanceof Uint8Array
                ? `x'${
                  Array.from(c, (b) => b.toString(16).padStart(2, "0")).join("")
                }'`
                : typeof c === "string"
                ? `'${c.replaceAll("'", "''")}'`
                : String(c);
            yield* db.execute("CREATE TABLE w AS SELECT * FROM v WHERE 0");
            for (const row of first.rows) {
              yield* db.execute(
                `INSERT INTO w VALUES (${row.map(literal).join(", ")})`,
              );
            }
            const second = yield* db.execute("SELECT * FROM w ORDER BY rowid");
            const exprs = yield* db.execute(
              "SELECT 1 = 1 AS t, 2 > 3 AS f, typeof(9007199254740993) AS ty, 2.0 AS two",
            );
            return { first, second, exprs };
          }),
      );
      const expected: Cell[][] = [
        [
          42,
          9007199254740993n,
          "héllo ☃",
          new Uint8Array([0, 255, 16]),
          1.5,
          null,
        ],
        [
          9007199254740991,
          -9223372036854775808n,
          "",
          new Uint8Array([]),
          -0.25,
          null,
        ],
        [
          -9007199254740991,
          9223372036854775807n,
          "x",
          new Uint8Array([127]),
          2,
          null,
        ],
      ];
      same(result.first.rows, expected, "normalized cells");
      check(
        typeof result.first.rows[0][0] === "number",
        "safe integer is a number",
      );
      check(
        typeof result.first.rows[0][1] === "bigint",
        "unsafe integer is a bigint",
      );
      check(
        result.first.rows[0][3] instanceof Uint8Array,
        "blob is a Uint8Array",
      );
      same(
        result.second.rows,
        expected,
        "cells written back as SQL round-trip",
      );
      same(result.exprs.rows, [[1, 0, "integer", 2]], "booleans and reals");
      const encoded = result.first.rows[0].map(encodeCell);
      same(encoded, [
        42,
        { $type: "bigint", value: "9007199254740993" },
        "héllo ☃",
        { $type: "blob", base64: "AP8Q" },
        1.5,
        null,
      ], "encodeCell JSON form");
      same(
        JSON.parse(JSON.stringify(encoded)).map(decodeCell),
        result.first.rows[0],
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
            };
          }),
      );
      same(
        result.dup.columns,
        ["a", "a", "count(*)"],
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
      same(
        result.empty.columns,
        ["id", "title", "completed", "created_at"],
        "empty result columns",
      );
      same(result.empty.rows, [], "empty result rows");
      same(result.truncated.rows, [[1], [2]], "truncated rows");
      check(result.truncated.truncated, "truncated flag");
      check(!result.whole.truncated, "untruncated flag");
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
        columns: ["count(*)"],
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
];

/** Runs every case (or those whose name contains `filter`) sequentially. */
export const runConformance = async (
  target: ConformanceTarget,
  filter = "",
): Promise<ConformanceOutcome[]> => {
  const outcomes: ConformanceOutcome[] = [];
  for (const c of conformanceCases) {
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
