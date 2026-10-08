import { assert, assertEquals } from "@std/assert";
import { Context, Effect, Exit, Fiber, Layer, PubSub, Scope, Stream } from "effect";
import { Database, type DbEvent, type DriverFactory, layer } from "../src/service.ts";
import { TASKS_SCHEMA, TASKS_SEED } from "../src/protocol.ts";
import { nodeSqliteFactory } from "../src/node-driver.ts";
import { wasmMemoryFactory } from "../src/wasm-driver-deno.ts";

type Mk = (hooks: { onClose?: () => void }) => DriverFactory;
const factories: Record<string, Mk> = {
  "node:sqlite": (h) => nodeSqliteFactory(":memory:", h),
  "sqlite-wasm": (h) => wasmMemoryFactory(h),
};

/** Build the layer in an explicit scope so the test can observe the finalizer. */
const withDb = async <A>(mk: Mk, body: (db: Context.Service.Shape<typeof Database>, closes: () => number) => Effect.Effect<A, unknown, Scope.Scope>) => {
  let closes = 0;
  const live = layer({ factory: mk({ onClose: () => closes++ }), schema: TASKS_SCHEMA, seed: TASKS_SEED });
  const scope = Effect.runSync(Scope.make());
  const ctx = await Effect.runPromise(Layer.build(live).pipe(Scope.provide(scope)));
  const db = Context.get(ctx, Database);
  try {
    return { result: await Effect.runPromise(body(db, () => closes).pipe(Scope.provide(scope))), closesBeforeScopeClose: closes };
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    assert(closes >= 1, "finalizer must close the driver");
  }
};

for (const [name, mk] of Object.entries(factories)) {
  Deno.test(`${name}: seeded tasks, tables(), schema()`, async () => {
    const { result } = await withDb(mk, (db) =>
      Effect.gen(function* () {
        const r = yield* db.execute("SELECT id, title, completed FROM tasks ORDER BY id");
        return { r, tables: yield* db.tables(), schema: yield* db.schema("tasks") };
      }));
    assertEquals(result.r.columns, ["id", "title", "completed"]);
    assertEquals(result.r.rows.length, 3);
    assertEquals(result.r.rows[0], [1, "Write the project plan", 1]);
    assertEquals(result.tables, ["tasks"]);
    assert(result.schema.startsWith("CREATE TABLE tasks"));
  });

  Deno.test(`${name}: bad SQL is a typed DatabaseError and emits no event`, async () => {
    const { result } = await withDb(mk, (db) =>
      Effect.gen(function* () {
        const sub = yield* db.subscribe;
        const err = yield* Effect.flip(db.execute("SELEC nope"));
        const missing = yield* Effect.flip(db.schema("nope"));
        const caught = yield* db.execute("SELEC nope").pipe(
          Effect.catchTag("DatabaseError", (e) => Effect.succeed(`caught:${e.operation}`)),
        );
        return { err, missing, caught, events: yield* PubSub.takeUpTo(sub, 100) };
      }));
    assertEquals(result.err._tag, "DatabaseError");
    assertEquals(result.err.operation, "execute");
    assert(/syntax error/.test(result.err.message), result.err.message);
    assertEquals(result.missing._tag, "DatabaseError");
    assertEquals(result.caught, "caught:execute");
    assertEquals(result.events, []);
  });

  Deno.test(`${name}: exactly one event per successful write, none for reads/no-op/failure`, async () => {
    const { result } = await withDb(mk, (db) =>
      Effect.gen(function* () {
        const sub = yield* db.subscribe;
        const ins = yield* db.execute("INSERT INTO tasks (title, created_at) VALUES ('a', 'now')");
        yield* db.execute("SELECT * FROM tasks"); // read: no event
        yield* db.execute("UPDATE tasks SET completed = 1 WHERE id = 999"); // 0 rows: no event
        yield* Effect.flip(db.execute("INSERT INTO tasks (title) VALUES ('missing created_at')")); // NOT NULL: no event
        const upd = yield* db.execute("UPDATE tasks SET completed = 1"); // 4 rows: one event
        yield* db.execute("CREATE INDEX tasks_title ON tasks(title)"); // DDL: one event (schemaChanged)
        const sel = yield* db.execute("SELECT count(*) AS n FROM tasks"); // changes must be 0 (not sticky)
        return { ins, upd, sel, events: yield* PubSub.takeUpTo(sub, 100) };
      }));
    assertEquals(result.ins.changes, 1);
    assertEquals(result.upd.changes, 4);
    assertEquals(result.sel.changes, 0);
    assertEquals(result.events, [
      { _tag: "Changed", changes: 1, schemaChanged: false },
      { _tag: "Changed", changes: 4, schemaChanged: false },
      { _tag: "Changed", changes: 0, schemaChanged: true },
    ] satisfies DbEvent[]);
  });

  Deno.test(`${name}: reset swaps the handle, keeps service identity, restores seeds`, async () => {
    const { result, closesBeforeScopeClose } = await withDb(mk, (db) =>
      Effect.gen(function* () {
        const sub = yield* db.subscribe;
        const before = db;
        yield* db.execute("DELETE FROM tasks; INSERT INTO tasks (title, created_at) VALUES ('x', 'now');");
        yield* db.reset();
        const after = yield* Database; // resolved again from context: same object
        const rows = yield* after.execute("SELECT id, title FROM tasks ORDER BY id");
        return { same: before === after, rows, events: yield* PubSub.takeUpTo(sub, 100) };
      }).pipe(Effect.provideService(Database, db)));
    assert(result.same);
    assertEquals(result.rows.rows.map((r) => r[0]), [1, 2, 3]);
    assertEquals(result.events.map((e) => e._tag), ["Changed", "Reset"]);
    assertEquals(closesBeforeScopeClose, 1, "reset closed the old handle exactly once");
  });

  Deno.test(`${name}: export/import round-trip and invalid import recovers`, async () => {
    const { result } = await withDb(mk, (db) =>
      Effect.gen(function* () {
        yield* db.execute("INSERT INTO tasks (title, created_at) VALUES ('exported', 'now')");
        const bytes = yield* db.exportBytes();
        yield* db.reset();
        const afterReset = yield* db.execute("SELECT count(*) FROM tasks");
        yield* db.importBytes(bytes);
        const afterImport = yield* db.execute("SELECT title FROM tasks ORDER BY id DESC LIMIT 1");
        const bad = yield* Effect.flip(db.importBytes(new TextEncoder().encode("not a database")));
        const stillUsable = yield* db.execute("SELECT count(*) FROM tasks");
        const corrupt = bytes.slice();
        corrupt.fill(0xab, 100); // valid header, garbage pages: sqlite3_deserialize accepts this
        const sub = yield* db.subscribe;
        const corruptErr = yield* Effect.flip(db.importBytes(corrupt));
        const restored = yield* db.execute("SELECT count(*) FROM tasks");
        return { size: bytes.byteLength, afterReset, afterImport, bad, stillUsable, corruptErr, restored, events: yield* PubSub.takeUpTo(sub, 10) };
      }));
    assert(result.size > 0);
    assertEquals(result.afterReset.rows, [[3]]);
    assertEquals(result.afterImport.rows, [["exported"]]);
    assertEquals(result.bad._tag, "DatabaseError");
    assertEquals(result.stillUsable.rows, [[4]], "invalid import rejected before touching the live handle");
    assertEquals(result.corruptErr._tag, "DatabaseError");
    assertEquals(result.corruptErr.operation, "import");
    assertEquals(result.restored.rows, [[4]], "failed import restored the pre-import snapshot");
    assertEquals(result.events, [], "failed import publishes nothing");
  });
}

Deno.test("changes Stream (Stream.fromPubSub) delivers write events in order", async () => {
  const { result } = await withDb(factories["node:sqlite"], (db) =>
    Effect.gen(function* () {
      const fiber = yield* db.changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow; // let the stream subscribe before publishing
      yield* db.execute("INSERT INTO tasks (title, created_at) VALUES ('s', 'now')");
      yield* db.reset();
      return yield* Fiber.join(fiber);
    }));
  assertEquals(result.map((e) => e._tag), ["Changed", "Reset"]);
});
