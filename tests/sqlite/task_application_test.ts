// R1 native suite: the task application core on D1's in-process SQLite
// services (node:sqlite and sqlite-wasm memory). Seeds, CRUD, reset, typed
// errors, change events and the change-driven reload loop used by the UI.
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
} from "@std/assert";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import type { DatabaseService } from "../../packages/core/types.ts";
import { nativeSqliteBackend } from "../../packages/database/native-sqlite.ts";
import {
  CORRUPT_DETAIL_LIMIT,
  CorruptTask,
  type DatabaseError as DatabaseErrorShape,
  describeTaskError,
  InvalidInput,
  LIST_LIMIT,
  TaskApplication,
  type TaskApplicationShape,
  TaskClock,
  taskManagerLayer,
  taskManagerLayerFromLookup,
  taskManagerLayerFromService,
  TaskNotFound,
  type TasksSnapshot,
  watchTasks,
} from "../../prototypes/task-manager/application.ts";
import { DatabaseError } from "../../packages/database/sqlite-service.ts";
import {
  TASKS_TABLE_SQL,
  TITLE_MAX_LENGTH,
} from "../../prototypes/task-manager/schema.ts";
import { SEED_TASKS } from "../../prototypes/task-manager/seed.ts";
import {
  TASKS_SCHEMA,
  TASKS_SEED_ROWS,
} from "../../packages/database/sqlite-seed.ts";
import {
  BACKENDS,
  CLOCK_START,
  failure,
  type Harness,
  withApp,
} from "./harness.ts";

const at = (seconds: number) =>
  new Date(Date.parse(CLOCK_START) + seconds * 1000).toISOString();

/** Runs watchTasks on `app` in a fiber and records what it reports. */
const startWatch = (h: Harness, app: TaskApplicationShape) => {
  const snapshots: TasksSnapshot[] = [];
  const errors: (CorruptTask | DatabaseErrorShape)[] = [];
  const fiber = Effect.runFork(
    watchTasks(
      (s) => snapshots.push(s),
      (e) => errors.push(e),
    ).pipe(Effect.provideService(TaskApplication, app)),
  );
  return {
    snapshots,
    errors,
    /** Waits (bounded) until `n` snapshots exist, then requires exactly n. */
    until: async (n: number) => {
      for (let i = 0; i < 200 && snapshots.length < n; i++) await h.tick();
      assertEquals(snapshots.length, n, "snapshot count");
    },
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
};

const cases: Record<string, (h: Harness) => Promise<void>> = {
  "seed: list returns the deterministic seed, ordered by id": async (h) => {
    assertEquals(await h.run(h.app.listTasks()), SEED_TASKS);
    assertEquals(await h.run(h.db.tables()), ["tasks"]);
    assertEquals(await h.run(h.db.schema("tasks")), TASKS_TABLE_SQL);
    assertEquals(await h.run(h.app.getTask(2)), SEED_TASKS[1]);
    await h.settle();
    assertEquals(h.events, [], "opening and reading publish nothing");
  },

  "create: trims, assigns the next id, stamps the injected clock": async (
    h,
  ) => {
    const a = await h.run(h.app.createTask("  Ship R1  "));
    assertEquals(a, {
      id: 4,
      title: "Ship R1",
      completed: false,
      createdAt: at(0),
    });
    const b = await h.run(h.app.createTask('O\'Brien said "hi" ☃'));
    assertEquals(b.id, 5);
    assertEquals(b.title, 'O\'Brien said "hi" ☃');
    assertEquals(b.createdAt, at(1));
    const injection = "x'); DROP TABLE tasks; --";
    const c = await h.run(h.app.createTask(injection));
    assertEquals(c.title, injection);
    const list = await h.run(h.app.listTasks());
    assertEquals(list, [...SEED_TASKS, a, b, c]);
    await h.settle();
    assertEquals(h.events.length, 3, "one event per create");
    for (const e of h.events) {
      assertEquals(e, {
        kind: "write",
        source: "app",
        changes: 1,
        schemaChanged: false,
      });
    }
  },

  "create: invalid titles fail with InvalidInput and write nothing": async (
    h,
  ) => {
    const bad: [unknown, string][] = [
      ["", "title is required"],
      ["   \t ", "title is required"],
      ["x".repeat(TITLE_MAX_LENGTH + 1), "at most 200"],
      ["a\u0000b", "control or bidi characters"],
      ["line\nbreak", "control or bidi characters"],
      ["next\u0085line", "control or bidi characters"], // C1 (Cc)
      ["evil\u202Etxt.exe", "control or bidi characters"], // RLO
      ["isolate\u2066x\u2069", "control or bidi characters"],
      ["arabic\u061Cmark", "control or bidi characters"],
      ["lone \uD800 high", "lone surrogates"],
      ["lone \uDC00 low", "lone surrogates"],
      [42, "title: Expected string"],
      [null, "title: Expected string"],
      [undefined, "title: Expected string"],
    ];
    for (const [input, text] of bad) {
      const e = await failure(h.app.createTask(input));
      assertInstanceOf(e, InvalidInput);
      assertEquals(e._tag, "InvalidInput");
      assert(
        e.message.includes(text),
        `${JSON.stringify(input)}: ${e.message}`,
      );
    }
    assertEquals(
      (await h.run(h.app.createTask("x".repeat(TITLE_MAX_LENGTH)))).title
        .length,
      TITLE_MAX_LENGTH,
    );
    assertEquals(
      (await h.run(h.app.createTask("party 🎉 héllo ☃"))).title,
      "party 🎉 héllo ☃",
      "surrogate pairs and non-ASCII letters are fine",
    );
    assertEquals((await h.run(h.app.listTasks())).length, 5);
    await h.settle();
    assertEquals(h.events.length, 2, "only the valid creates published");
  },

  "complete / update / delete: success paths": async (h) => {
    const done = await h.run(h.app.completeTask(2));
    assertEquals(done, { ...SEED_TASKS[1], completed: true });
    const again = await h.run(h.app.completeTask(2));
    assertEquals(again, done, "completing twice is idempotent");
    const renamed = await h.run(
      h.app.updateTask(3, { title: "  Wire the CLI " }),
    );
    assertEquals(renamed, { ...SEED_TASKS[2], title: "Wire the CLI" });
    const reopened = await h.run(h.app.updateTask(1, { completed: false }));
    assertEquals(reopened, { ...SEED_TASKS[0], completed: false });
    const both = await h.run(
      h.app.updateTask(2, { title: "Both", completed: false }),
    );
    assertEquals(both, { ...SEED_TASKS[1], title: "Both", completed: false });
    const deleted = await h.run(h.app.deleteTask(3));
    assertEquals(deleted, renamed, "delete returns the task as it was");
    assertEquals(await h.run(h.app.listTasks()), [reopened, both]);
    // INTEGER PRIMARY KEY (no AUTOINCREMENT) reuses the max id + 1.
    assertEquals((await h.run(h.app.createTask("next"))).id, 3);
  },

  "missing ids fail with TaskNotFound and write nothing": async (h) => {
    for (
      const op of [
        h.app.getTask(99),
        h.app.completeTask(99),
        h.app.updateTask(99, { title: "x" }),
        h.app.updateTask(99, { completed: true }),
        h.app.deleteTask(99),
      ]
    ) {
      const e = await failure(op);
      assertInstanceOf(e, TaskNotFound);
      assertEquals(e.id, 99);
    }
    await h.run(h.app.deleteTask(1));
    const gone = await failure(h.app.deleteTask(1));
    assertInstanceOf(gone, TaskNotFound);
    assertEquals((await failure(h.app.getTask(1)))._tag, "TaskNotFound");
    assertEquals((await h.run(h.app.listTasks())).length, 2);
    await h.settle();
    assertEquals(h.events.length, 1, "only the real delete published");
  },

  "invalid ids and patches fail with InvalidInput": async (h) => {
    const ids: unknown[] = [0, -1, 1.5, "1", NaN, Infinity, 2 ** 60, null];
    for (const id of ids) {
      for (
        const op of [
          h.app.getTask(id),
          h.app.completeTask(id),
          h.app.deleteTask(id),
          h.app.updateTask(id, { completed: true }),
        ]
      ) {
        const e = await failure(op);
        assertInstanceOf(e, InvalidInput, String(id));
        assert(e.message.startsWith("id"), e.message);
      }
    }
    const patches: [unknown, string][] = [
      [{}, "nothing to update"],
      [{ title: "" }, "title is required"],
      [{ completed: "yes" }, "completed: Expected boolean"],
      [null, "patch"],
      ["done", "patch"],
    ];
    for (const [patch, text] of patches) {
      const e = await failure(h.app.updateTask(1, patch));
      assertInstanceOf(e, InvalidInput);
      assert(
        e.message.includes(text),
        `${JSON.stringify(patch)}: ${e.message}`,
      );
    }
    assertEquals(await h.run(h.app.listTasks()), SEED_TASKS);
    await h.settle();
    assertEquals(h.events, []);
  },

  "typed errors are catchable by tag and describable": async (h) => {
    const recovered = await h.run(
      h.app.completeTask(404).pipe(
        Effect.catchTag("TaskNotFound", (e) => Effect.succeed(`nf ${e.id}`)),
        Effect.catchTag("InvalidInput", () => Effect.succeed("invalid")),
      ),
    );
    assertEquals(recovered, "nf 404");
    const invalid = await h.run(
      h.app.createTask("").pipe(
        Effect.catchTag("InvalidInput", (e) => Effect.succeed(e.message)),
      ),
    );
    assertEquals(invalid, "title is required");
    assertEquals(
      describeTaskError(new TaskNotFound({ id: 7 })),
      "Task 7 not found",
    );
    assertEquals(
      describeTaskError(new InvalidInput({ message: "title is required" })),
      "Invalid input: title is required",
    );
    assertEquals(
      describeTaskError(
        new DatabaseError({ operation: "execute", message: "boom", cause: 1 }),
      ),
      "Database error (execute): boom",
    );
    assertEquals(
      describeTaskError(
        new CorruptTask({ ids: ["3"], message: "task 3: bad" }),
      ),
      "Stored data the app cannot read (task 3: bad); fix or delete it with SQL, or reset",
    );
  },

  "reset returns exactly the seed and publishes one reset": async (h) => {
    await h.run(h.app.createTask("temporary"));
    await h.run(h.app.completeTask(2));
    await h.run(h.app.deleteTask(1));
    await h.run(h.db.execute("CREATE TABLE scratch (x)", { source: "shell" }));
    await h.run(h.app.reset());
    assertEquals(await h.run(h.app.listTasks()), SEED_TASKS);
    assertEquals(await h.run(h.db.tables()), ["tasks"]);
    assertEquals((await h.run(h.app.createTask("after reset"))).id, 4);
    await h.settle();
    assertEquals(h.events.map((e) => `${e.kind}/${e.source}`), [
      "write/app",
      "write/app",
      "write/app",
      "write/shell",
      "reset/host",
      "write/app",
    ]);
  },

  "concurrent creates get distinct ids": async (h) => {
    const created = await h.run(
      Effect.forEach(
        Array.from({ length: 20 }, (_, i) => `task ${i}`),
        (t) => h.app.createTask(t),
        { concurrency: "unbounded" },
      ),
    );
    const ids = created.map((t) => t.id).sort((a, b) => a - b);
    assertEquals(ids, Array.from({ length: 20 }, (_, i) => i + 4));
    assertEquals((await h.run(h.app.listTasks())).length, 23);
  },

  "unreadable rows: CorruptTask names them; mutations write nothing": async (
    h,
  ) => {
    // Case A (review finding 4): the shell sets completed = 7.
    await h.run(
      h.db.execute("UPDATE tasks SET completed = 7 WHERE id = 3", {
        source: "shell",
      }),
    );
    await h.settle();
    const before = h.events.length;
    const list = await failure(h.app.listTasks());
    assertInstanceOf(list, CorruptTask);
    assertEquals(list.ids, ["3"]);
    assert(
      list.message.includes("task 3: row[2]: Expected 0 | 1"),
      list.message,
    );
    for (
      const op of [
        h.app.getTask(3),
        h.app.deleteTask(3),
        h.app.completeTask(3),
        h.app.updateTask(3, { title: "fixed?" }),
      ]
    ) {
      const e = await failure(op);
      assertInstanceOf(e, CorruptTask);
      assertEquals(e.ids, ["3"]);
    }
    const still = await h.run(
      h.db.execute("SELECT title, completed FROM tasks WHERE id = 3"),
    );
    assertEquals(still.rows, [["Wire the terminal", 7]], "nothing written");
    await h.settle();
    assertEquals(h.events.length, before, "no change event from refusals");
    // Readable rows keep working; every bad row is named.
    assertEquals((await h.run(h.app.completeTask(2))).completed, true);
    await h.run(
      h.db.execute("UPDATE tasks SET title = x'00' WHERE id = 1", {
        source: "shell",
      }),
    );
    assertEquals((await failure(h.app.listTasks()) as CorruptTask).ids, [
      "1",
      "3",
    ]);
    // Not wedged: fixing the rows with SQL, or a reset, recovers.
    await h.run(h.db.execute("UPDATE tasks SET completed = 0 WHERE id = 3"));
    await h.run(h.app.reset());
    assertEquals(await h.run(h.app.listTasks()), SEED_TASKS);
  },

  "every unreadable column: mutations are refused, nothing written": async (
    h,
  ) => {
    // One corruption per READABLE_ROW clause the shell can reach (id is the
    // rowid, so always an integer; see the id-space case for its range).
    const corruptions: [number, string][] = [
      [1, "UPDATE tasks SET title = x'00' WHERE id = 1"],
      [2, "UPDATE tasks SET created_at = x'00' WHERE id = 2"],
      [3, "UPDATE tasks SET completed = 7 WHERE id = 3"],
    ];
    const snapshot = (id: number) =>
      h.run(
        h.db.execute(
          `SELECT id, quote(title), quote(completed), quote(created_at) FROM tasks WHERE id = ${id}`,
        ),
      ).then((r) => r.rows);
    for (const [id, sql] of corruptions) {
      await h.run(h.db.execute(sql, { source: "shell" }));
      await h.settle();
      const before = h.events.length;
      const stored = await snapshot(id);
      assertEquals(stored.length, 1);
      for (
        const op of [
          h.app.deleteTask(id),
          h.app.completeTask(id),
          h.app.updateTask(id, { completed: false }),
          h.app.updateTask(id, { title: "repaired?" }),
          h.app.getTask(id),
        ]
      ) {
        const e = await failure(op);
        assertInstanceOf(e, CorruptTask, sql);
        assertEquals(e.ids, [String(id)], sql);
      }
      assertEquals(await snapshot(id), stored, `row ${id} unchanged`);
      await h.settle();
      assertEquals(h.events.length, before, `no event after ${sql}`);
    }
    assertEquals((await failure(h.app.listTasks()) as CorruptTask).ids, [
      "1",
      "2",
      "3",
    ]);
  },

  "CorruptTask message details at most CORRUPT_DETAIL_LIMIT rows": async (
    h,
  ) => {
    await h.run(
      h.db.execute(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 7)
         INSERT INTO tasks (title, completed, created_at) SELECT 'bad', 9, 't' FROM n`,
      ),
    );
    const e = await failure(h.app.listTasks()) as CorruptTask;
    assertEquals(e.ids, ["4", "5", "6", "7", "8", "9", "10"]);
    assertEquals(CORRUPT_DETAIL_LIMIT, 5);
    assert(e.message.endsWith("; and 2 more"), e.message);
    assert(e.message.includes("task 8:") && !e.message.includes("task 9:"));
  },

  "guarded mutation racing an external fix: DatabaseError, nothing written":
    async (h) => {
      // The row is unreadable when the guarded statement runs (0 rows back)
      // and readable again before mutate's follow-up read: a concurrent
      // external write. The app must neither report success nor not-found.
      await h.run(
        h.db.execute("UPDATE tasks SET completed = 7 WHERE id = 3", {
          source: "shell",
        }),
      );
      const racing: DatabaseService = {
        ...h.db,
        execute: (sql, options) =>
          h.db.execute(sql, options).pipe(
            Effect.tap((r) =>
              r.rows.length === 0 && /^(UPDATE|DELETE) /.test(sql)
                ? h.db.execute(
                  "UPDATE tasks SET completed = 0 WHERE id = 3",
                  { source: "shell" },
                ).pipe(Effect.asVoid)
                : Effect.void
            ),
          ),
      };
      const runtime = ManagedRuntime.make(
        taskManagerLayerFromService(racing, TaskClock.fixed(CLOCK_START)),
      );
      try {
        const app = await runtime.runPromise(
          Effect.gen(function* () {
            return yield* TaskApplication;
          }),
        );
        for (
          const [op, fix] of [
            [() => app.deleteTask(3), "delete"],
            [() => app.completeTask(3), "complete"],
            [() => app.updateTask(3, { title: "x" }), "update"],
          ] as const
        ) {
          // Re-break the row; the racing wrapper repairs it mid-operation.
          await h.run(
            h.db.execute("UPDATE tasks SET completed = 7 WHERE id = 3", {
              source: "shell",
            }),
          );
          await h.settle();
          const before = h.events.length;
          const e = await failure(op());
          assertInstanceOf(e, DatabaseError, fix);
          assertEquals(
            e.message,
            "task 3 changed concurrently; nothing written",
          );
          const row = await h.run(
            h.db.execute("SELECT title, completed FROM tasks WHERE id = 3"),
          );
          assertEquals(row.rows, [["Wire the terminal", 0]], fix);
          await h.settle();
          assertEquals(
            h.events.slice(before).map((c) => c.source),
            ["shell"],
            `${fix}: only the external repair published`,
          );
        }
      } finally {
        await runtime.dispose();
      }
    },

  "id space: createTask refuses past 2^53-1 and writes nothing": async (h) => {
    // Case B (review finding 4): the shell inserts the largest safe id.
    await h.run(
      h.db.execute(
        "INSERT INTO tasks VALUES (9007199254740991, 'max', 0, 't')",
        { source: "shell" },
      ),
    );
    await h.settle();
    const before = h.events.length;
    const e = await failure(h.app.createTask("one too many"));
    assertInstanceOf(e, DatabaseError);
    assert(e.message.includes("no task id left"), e.message);
    await h.settle();
    assertEquals(h.events.length, before, "no change event");
    const listed = await h.run(h.app.listTasks());
    assertEquals(listed.length, 4, "list still readable, nothing inserted");
    assertEquals(listed.at(-1)?.id, 9007199254740991);
    assertEquals(
      (await h.run(h.app.deleteTask(9007199254740991))).title,
      "max",
    );
    assertEquals((await h.run(h.app.createTask("fits again"))).id, 4);
    // An unsafe id written by the shell is named, not silently rounded.
    await h.run(
      h.db.execute(
        "INSERT INTO tasks VALUES (1152921504606846976, 'big', 0, 't')",
      ),
    );
    assertEquals((await failure(h.app.listTasks()) as CorruptTask).ids, [
      "1152921504606846976",
    ]);
  },

  "listTasks refuses to truncate past LIST_LIMIT": async (h) => {
    const fill = (n: number) =>
      h.db.execute(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})
         INSERT INTO tasks (title, completed, created_at) SELECT 'bulk ' || i, 0, 't' FROM n`,
      );
    await h.run(fill(LIST_LIMIT - SEED_TASKS.length));
    assertEquals((await h.run(h.app.listTasks())).length, LIST_LIMIT);
    await h.run(fill(1));
    const e = await failure(h.app.listTasks());
    assertInstanceOf(e, DatabaseError);
    assertEquals(
      e.message,
      `more than ${LIST_LIMIT} tasks; listTasks refuses to truncate`,
    );
  },

  "watchTasks reloads on every change source and never on a timer": async (
    h,
  ) => {
    const w = startWatch(h, h.app);
    try {
      await w.until(1);
      assertEquals(w.snapshots[0].tasks, SEED_TASKS);
      assertEquals(w.snapshots[0].changes, []);
      assertEquals(w.snapshots[0].load, 1);

      // Idle: no reloads without changes (no polling).
      await new Promise((r) => setTimeout(r, 300));
      assertEquals(w.snapshots.length, 1);

      await h.run(h.app.createTask("from the app"));
      await w.until(2);
      assertEquals(w.snapshots[1].tasks.at(-1)?.title, "from the app");
      assertEquals(w.snapshots[1].changes.map((c) => c.source), ["app"]);

      // A write that bypasses the application, on the same service.
      await h.run(
        h.db.execute(
          "UPDATE tasks SET title = 'renamed outside' WHERE id = 1",
          { source: "shell" },
        ),
      );
      await w.until(3);
      assertEquals(w.snapshots[2].tasks[0].title, "renamed outside");
      assertEquals(w.snapshots[2].changes.map((c) => c.source), ["shell"]);

      // Reads, no-op updates and failed statements publish nothing.
      await h.run(h.app.listTasks());
      await h.run(h.db.execute("UPDATE tasks SET title = title WHERE 0"));
      await failure(h.db.execute("SELECT * FROM nope"));
      await failure(h.app.completeTask(404));
      await new Promise((r) => setTimeout(r, 100));
      assertEquals(w.snapshots.length, 3);

      await h.run(h.app.reset());
      await w.until(4);
      assertEquals(w.snapshots[3].tasks, SEED_TASKS);
      assertEquals(w.snapshots[3].changes.map((c) => c.kind), ["reset"]);
      assertEquals(w.snapshots.map((s) => s.load), [1, 2, 3, 4]);

      // An unreadable row is reported (CorruptTask) and watching continues.
      await h.run(
        h.db.execute("INSERT INTO tasks VALUES (9, 'bad', 2, 'x')", {
          source: "shell",
        }),
      );
      for (let i = 0; i < 200 && w.errors.length === 0; i++) await h.tick();
      assertEquals(w.errors.map((e) => e._tag), ["CorruptTask"]);
      await h.run(h.db.execute("DELETE FROM tasks WHERE id = 9"));
      await w.until(5);
      assertEquals(w.snapshots.at(-1)?.tasks, SEED_TASKS);
    } finally {
      await w.stop();
    }
  },

  "watchTasks: a write between the first read and subscribing is not missed":
    async (h) => {
      // The first load itself causes a write right after reading. If the
      // subscription were taken after the first load, that write's event
      // would be lost and the list would stay stale.
      let first = true;
      const app: TaskApplicationShape = {
        ...h.app,
        listTasks: () =>
          h.app.listTasks().pipe(
            Effect.tap(() => {
              if (!first) return Effect.void;
              first = false;
              return h.db.execute(
                "INSERT INTO tasks (title, completed, created_at) VALUES ('between', 0, 't')",
                { source: "shell" },
              ).pipe(Effect.orDie);
            }),
          ),
      };
      const w = startWatch(h, app);
      try {
        await w.until(2);
        assertEquals(w.snapshots[0].tasks, SEED_TASKS, "read before write");
        assertEquals(w.snapshots[1].tasks.at(-1)?.title, "between");
        assertEquals(w.snapshots[1].changes.map((c) => c.source), ["shell"]);
      } finally {
        await w.stop();
      }
    },

  "watchTasks: changes queued during a reload coalesce into one reload": async (
    h,
  ) => {
    // A gate holds reload #2 after its read; three writes land meanwhile.
    let gate: Promise<void> | undefined;
    let release = () => {};
    let entered = () => {};
    const inGate = new Promise<void>((r) => (entered = r));
    const app: TaskApplicationShape = {
      ...h.app,
      listTasks: () =>
        h.app.listTasks().pipe(
          Effect.tap(() => {
            const g = gate;
            if (!g) return Effect.void;
            gate = undefined;
            entered();
            return Effect.promise(() => g);
          }),
        ),
    };
    const w = startWatch(h, app);
    try {
      await w.until(1);
      gate = new Promise<void>((r) => (release = r));
      await h.run(h.app.createTask("w0"));
      await inGate;
      for (const id of [1, 2, 3]) await h.run(h.app.deleteTask(id));
      await h.settle();
      assertEquals(h.events.length, 4, "four writes published");
      release();
      await w.until(3);
      await new Promise((r) => setTimeout(r, 200));
      assertEquals(w.snapshots.length, 3, "exactly one reload for three");
      assertEquals(w.snapshots[1].changes.length, 1);
      assertEquals(w.snapshots[2].changes.length, 3);
      assertEquals(w.snapshots[2].tasks.map((t) => t.title), ["w0"]);
    } finally {
      await w.stop();
    }
  },
};

Deno.test("seed and table match D1's workbench seed (shared database)", () => {
  assertEquals(TASKS_TABLE_SQL, TASKS_SCHEMA);
  assertEquals(
    SEED_TASKS.map((t) => [t.id, t.title, t.completed ? 1 : 0, t.createdAt]),
    TASKS_SEED_ROWS.map((r) => [...r]),
  );
});

for (const backend of BACKENDS) {
  for (const [name, body] of Object.entries(cases)) {
    Deno.test(`${backend}: ${name}`, () => withApp(backend, body));
  }
}

Deno.test("shared-service layer fails visibly when no service appears", async () => {
  const missing = ManagedRuntime.make(
    taskManagerLayerFromLookup(() => undefined, {
      what: "test hook",
      timeoutMs: 60,
      pollMs: 10,
    }),
  );
  const e = await missing.runPromise(
    Effect.gen(function* () {
      return yield* TaskApplication;
    }),
  ).then(() => undefined, (err: unknown) => err);
  await missing.dispose();
  assertInstanceOf(e, DatabaseError);
  assertEquals(
    e.message,
    "no shared database service on this page: test hook did not appear within 60 ms",
  );

  // Appearing later is fine; the app then runs on exactly that service.
  await withApp("node:sqlite memory", async (h) => {
    let service: typeof h.db | undefined;
    setTimeout(() => (service = h.db), 30);
    const shared = ManagedRuntime.make(
      taskManagerLayerFromLookup(() => service, {
        what: "test hook",
        timeoutMs: 5_000,
        pollMs: 10,
      }),
    );
    try {
      const app = await shared.runPromise(
        Effect.gen(function* () {
          return yield* TaskApplication;
        }),
      );
      await Effect.runPromise(app.createTask("via lookup"));
      assertEquals(
        (await h.run(h.app.listTasks())).at(-1)?.title,
        "via lookup",
      );
    } finally {
      await shared.dispose();
    }
    assertEquals((await h.run(h.app.listTasks())).length, 4, "service kept");
  });
});

Deno.test("scoped runtime: disposal releases the database", async () => {
  let closed = 0;
  let disposed = 0;
  const runtime = ManagedRuntime.make(
    taskManagerLayer({
      backend: nativeSqliteBackend({
        onClose: () => closed++,
        onDispose: () => disposed++,
      }),
      clock: TaskClock.fixed(CLOCK_START),
    }).pipe(Layer.orDie),
  );
  const app = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* TaskApplication;
    }),
  );
  assertEquals((await Effect.runPromise(app.listTasks())).length, 3);
  await runtime.dispose();
  assertStrictEquals(closed, 1);
  assertStrictEquals(disposed, 1);
  const e = await failure(app.listTasks());
  assertEquals(e._tag, "DatabaseError");
});
