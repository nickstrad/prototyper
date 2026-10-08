// R3 native suite: the task manager fetch API on D1's in-process SQLite
// services. For each backend ONE runtime serves every case, so the handler,
// the application service, the raw DatabaseService and the change stream are
// the same objects throughout; cases reset the database between them with
// the application's own reset(), and the shared-runtime cases prove that a
// write made through any one door is visible through the others.
import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import {
  MAX_TASK_ID,
  TaskApplication,
  type TaskApplicationShape,
  type TasksSnapshot,
  watchTasks,
} from "../../prototypes/task-manager/application.ts";
import {
  createTaskApiHandler,
  type TaskApiServices,
} from "../../prototypes/task-manager/api.ts";
import { isSingleStatement } from "../../prototypes/task-manager/api.ts";
import { SEED_TASKS } from "../../prototypes/task-manager/seed.ts";
import { type ApiHarness, BACKENDS, withApi } from "./harness.ts";

const errorOf = (r: { json: { error: { code: string; message: string } } }) =>
  r.json.error;

const cases: Record<string, (h: ApiHarness) => Promise<void>> = {
  "GET /tasks lists the seed as JSON, publishing nothing": async (h) => {
    const r = await h.call("GET", "/tasks");
    assertEquals(r.status, 200);
    assertEquals(
      r.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assertEquals(r.json, SEED_TASKS);
    assertEquals(await h.drain(), []);
  },

  "GET /tasks/:id returns one task": async (h) => {
    const r = await h.call("GET", "/tasks/2");
    assertEquals(r.status, 200);
    assertEquals(r.json, SEED_TASKS[1]);
  },

  "POST /tasks creates: 201, Location, trimmed title, one app write event":
    async (h) => {
      await h.drain();
      const r = await h.call("POST", "/tasks", { title: "  Ship the API  " });
      assertEquals(r.status, 201);
      assertEquals(r.json.id, 4);
      assertEquals(r.json.title, "Ship the API");
      assertEquals(r.json.completed, false);
      assertMatch(r.json.createdAt, /^\d{4}-\d\d-\d\dT.*Z$/);
      assertEquals(r.headers.get("location"), "/tasks/4");
      assertEquals(await h.drain(), [
        { kind: "write", source: "app", changes: 1, schemaChanged: false },
      ]);
      assertEquals((await h.call("GET", "/tasks/4")).json, r.json);
    },

  "PATCH /tasks/:id changes title, completed, or both": async (h) => {
    const t = await h.call("PATCH", "/tasks/2", { title: "Renamed" });
    assertEquals(t.status, 200);
    assertEquals(t.json, { ...SEED_TASKS[1], title: "Renamed" });
    const c = await h.call("PATCH", "/tasks/2", { completed: true });
    assertEquals(c.json.completed, true);
    const both = await h.call("PATCH", "/tasks/2", {
      title: "Again",
      completed: false,
    });
    assertEquals([both.json.title, both.json.completed], ["Again", false]);
    assertEquals((await h.runApp(h.app.getTask(2))).title, "Again");
  },

  "POST /tasks/:id/complete completes": async (h) => {
    const r = await h.call("POST", "/tasks/2/complete");
    assertEquals(r.status, 200);
    assertEquals(r.json, { ...SEED_TASKS[1], completed: true });
    assertEquals((await h.call("GET", "/tasks/2")).json.completed, true);
  },

  "DELETE /tasks/:id returns the deleted task, then it is gone": async (h) => {
    const r = await h.call("DELETE", "/tasks/3");
    assertEquals(r.status, 200);
    assertEquals(r.json, SEED_TASKS[2]);
    assertEquals((await h.call("GET", "/tasks/3")).status, 404);
    assertEquals((await h.call("GET", "/tasks")).json.length, 2);
  },

  "POST /reset restores the seed and publishes a reset": async (h) => {
    await h.call("POST", "/tasks", { title: "extra" });
    await h.call("DELETE", "/tasks/1");
    await h.drain();
    const r = await h.call("POST", "/reset");
    assertEquals(r.status, 200);
    assertEquals(r.json, { reset: true });
    assertEquals((await h.call("GET", "/tasks")).json, SEED_TASKS);
    const events = await h.drain();
    assertEquals(events.map((e) => e.kind), ["reset"]);
  },

  "POST /sql: rows, bigint and blob cells through encodeCell": async (h) => {
    const r = await h.callWithSql("POST", "/sql", {
      sql:
        "SELECT id, title, NULL, 9007199254740993, x'00ff' FROM tasks WHERE id = 1",
    });
    assertEquals(r.status, 200);
    assertEquals(r.json.columns.length, 5);
    assertEquals(r.json.rows, [[
      1,
      SEED_TASKS[0].title,
      null,
      { $type: "bigint", value: "9007199254740993" },
      { $type: "blob", base64: "AP8=" },
    ]]);
    assertEquals(r.json.truncated, false);
  },

  "POST /sql writes are visible to the task routes and the change stream":
    async (h) => {
      await h.drain();
      const r = await h.callWithSql("POST", "/sql", {
        sql:
          "INSERT INTO tasks (title, completed, created_at) VALUES ('via sql', 0, '2026-03-01T00:00:00.000Z')",
      });
      assertEquals(r.status, 200);
      assertEquals(r.json.changes, 1);
      assertEquals((await h.call("GET", "/tasks/4")).json.title, "via sql");
      assertEquals((await h.drain()).map((e) => [e.kind, e.source]), [
        ["write", "host"],
      ]);
    },

  "POST /sql honours maxRows: capped rows and truncated": async (h) => {
    const r = await h.callWithSql("POST", "/sql", {
      sql: "SELECT id FROM tasks ORDER BY id",
      maxRows: 2,
    });
    assertEquals(r.status, 200);
    assertEquals(r.json.rows, [[1], [2]]);
    assertEquals(r.json.truncated, true);
    const all = await h.callWithSql("POST", "/sql", {
      sql: "SELECT id FROM tasks ORDER BY id",
    });
    assertEquals(all.json.rows.length, 3);
    assertEquals(all.json.truncated, false);
  },

  "POST /sql is one statement per request: scripts are refused, nothing runs":
    async (h) => {
      await h.drain();
      for (
        const sql of [
          "INSERT INTO tasks (title, completed, created_at) VALUES ('a', 0, 'x'); SELEKT 1",
          "DELETE FROM tasks; DELETE FROM tasks",
          "SELECT 1; -- not a comment-only tail\nSELECT 2",
          "SELECT 1;;",
          "INSERT INTO tasks (title, completed, created_at) VALUES ('a', 0, 'x');\u00a0",
        ]
      ) {
        const r = await h.callWithSql("POST", "/sql", { sql });
        assertEquals([r.status, errorOf(r).code], [400, "InvalidInput"], sql);
        assertMatch(errorOf(r).message, /single statement/);
      }
      assertEquals((await h.call("GET", "/tasks")).json, SEED_TASKS);
      assertEquals(await h.drain(), [], "nothing was executed or published");
      // Semicolons that are not statement separators are fine.
      for (
        const sql of [
          "SELECT ';' AS semi",
          'SELECT 1 AS "a;b"',
          "SELECT 'it''s; fine'",
          "SELECT 1; ",
          "SELECT 1; -- trailing comment",
          "SELECT 1 /* ; */",
        ]
      ) {
        const r = await h.callWithSql("POST", "/sql", { sql });
        assertEquals(r.status, 200, sql);
      }
    },

  "POST /sql is absent by default: 404 RouteNotFound, nothing executed": async (
    h,
  ) => {
    await h.drain();
    const r = await h.call("POST", "/sql", { sql: "DROP TABLE tasks" });
    assertEquals([r.status, errorOf(r).code], [404, "RouteNotFound"]);
    assertEquals((await h.call("GET", "/tasks")).json, SEED_TASKS);
    assertEquals(await h.drain(), []);
    // ...while the opted-in handler on the same runtime serves it.
    assertEquals(
      (await h.callWithSql("POST", "/sql", { sql: "SELECT 1" })).status,
      200,
    );
  },

  "POST /sql: engine errors are 400 SqlError, bad input 400 InvalidInput":
    async (h) => {
      const bad = await h.callWithSql("POST", "/sql", { sql: "SELEKT 1" });
      assertEquals(bad.status, 400);
      assertEquals(errorOf(bad).code, "SqlError");
      for (
        const body of [{}, { sql: "  " }, { sql: 1 }, [], {
          sql: "SELECT 1",
          maxRows: 0,
        }]
      ) {
        const r = await h.callWithSql("POST", "/sql", body);
        assertEquals(
          [r.status, errorOf(r).code],
          [400, "InvalidInput"],
          JSON.stringify(body),
        );
      }
    },

  // ---- 400 ------------------------------------------------------------------

  "400 InvalidInput: blank, missing, over-long and control-character titles":
    async (h) => {
      await h.drain();
      const bodies: unknown[] = [
        { title: "   " },
        { title: "" },
        {},
        { title: 5 },
        { title: "x".repeat(201) },
        { title: "tab\there" },
      ];
      for (const body of bodies) {
        const r = await h.call("POST", "/tasks", body);
        assertEquals(r.status, 400, JSON.stringify(body));
        assertEquals(errorOf(r).code, "InvalidInput");
        assert(errorOf(r).message.length > 0);
      }
      assertEquals(
        (await h.call("POST", "/tasks", { title: "   " })).json.error.message,
        "Invalid input: title is required",
      );
      assertEquals(
        (await h.call("GET", "/tasks")).json,
        SEED_TASKS,
        "nothing written",
      );
      assertEquals(await h.drain(), [], "no change event");
    },

  "400: body that is not a JSON object, or not JSON at all": async (h) => {
    for (const body of ["[1]", "null", '"str"', "7"]) {
      const r = await h.call("POST", "/tasks", body);
      assertEquals([r.status, errorOf(r).code], [400, "InvalidInput"], body);
    }
    const none = await h.call("POST", "/tasks");
    assertEquals([none.status, errorOf(none).code], [400, "InvalidInput"]);
    const bad = await h.call("POST", "/tasks", "{ not json");
    assertEquals([bad.status, errorOf(bad).code], [400, "InvalidJson"]);
    const patchBad = await h.call("PATCH", "/tasks/1", "{");
    assertEquals([patchBad.status, errorOf(patchBad).code], [
      400,
      "InvalidJson",
    ]);
  },

  "400 InvalidInput: bad ids on every id route": async (h) => {
    const ids = ["abc", "0", "-1", "1.5", "9007199254740993", "1e3"];
    for (const id of ids) {
      for (
        const [method, suffix, body] of [
          ["GET", "", undefined],
          ["PATCH", "", { completed: true }],
          ["DELETE", "", undefined],
          ["POST", "/complete", undefined],
        ] as const
      ) {
        const r = await h.call(method, `/tasks/${id}${suffix}`, body);
        assertEquals(r.status, 400, `${method} /tasks/${id}${suffix}`);
        assertEquals(errorOf(r).code, "InvalidInput");
      }
    }
  },

  "400 InvalidInput: bad PATCH bodies": async (h) => {
    for (
      const body of [{}, { completed: "yes" }, { title: "  " }, { title: 3 }]
    ) {
      const r = await h.call("PATCH", "/tasks/1", body);
      assertEquals(
        [r.status, errorOf(r).code],
        [400, "InvalidInput"],
        JSON.stringify(body),
      );
    }
    assertEquals(
      (await h.call("GET", "/tasks")).json,
      SEED_TASKS,
      "nothing written",
    );
  },

  // ---- 404 / 405 --------------------------------------------------------------

  "404 TaskNotFound on every id route": async (h) => {
    await h.drain();
    for (
      const [method, path, body] of [
        ["GET", "/tasks/999", undefined],
        ["PATCH", "/tasks/999", { completed: true }],
        ["DELETE", "/tasks/999", undefined],
        ["POST", "/tasks/999/complete", undefined],
      ] as const
    ) {
      const r = await h.call(method, path, body);
      assertEquals(r.status, 404, `${method} ${path}`);
      assertEquals(r.json, {
        error: { code: "TaskNotFound", message: "Task 999 not found" },
      });
    }
    assertEquals(await h.drain(), [], "no change event");
  },

  "404 RouteNotFound and 405 MethodNotAllowed are distinct from TaskNotFound":
    async (h) => {
      const missing = await h.call("GET", "/nope");
      assertEquals([missing.status, errorOf(missing).code], [
        404,
        "RouteNotFound",
      ]);
      const method = await h.call("PUT", "/tasks/1", { title: "x" });
      assertEquals([method.status, errorOf(method).code], [
        405,
        "MethodNotAllowed",
      ]);
      assertEquals(method.headers.get("allow"), "DELETE, GET, PATCH");
    },

  // ---- 500 ------------------------------------------------------------------

  "500 CorruptTask when a stored row is unreadable; nothing is written": async (
    h,
  ) => {
    await Effect.runPromise(
      h.db.execute("UPDATE tasks SET completed = 7 WHERE id = 2", {
        source: "shell",
      }),
    );
    await h.drain();
    const list = await h.call("GET", "/tasks");
    assertEquals(list.status, 500);
    assertEquals(errorOf(list).code, "CorruptTask");
    assertMatch(errorOf(list).message, /task 2/);
    const get = await h.call("GET", "/tasks/2");
    assertEquals([get.status, errorOf(get).code], [500, "CorruptTask"]);
    const patch = await h.call("PATCH", "/tasks/2", { title: "fix" });
    assertEquals([patch.status, errorOf(patch).code], [500, "CorruptTask"]);
    const del = await h.call("DELETE", "/tasks/2");
    assertEquals([del.status, errorOf(del).code], [500, "CorruptTask"]);
    assertEquals(await h.drain(), [], "no change event from refused writes");
    // A healthy row beside the corrupt one still answers.
    assertEquals((await h.call("GET", "/tasks/1")).status, 200);
  },

  "500 DatabaseError when the database refuses (no task id left)": async (
    h,
  ) => {
    await Effect.runPromise(
      h.db.execute(
        `INSERT INTO tasks (id, title, completed, created_at) VALUES (${MAX_TASK_ID}, 'last', 0, '2026-01-01T00:00:00.000Z')`,
      ),
    );
    await h.drain();
    const r = await h.call("POST", "/tasks", { title: "no room" });
    assertEquals(r.status, 500);
    assertEquals(errorOf(r).code, "DatabaseError");
    assertMatch(errorOf(r).message, /no task id left/);
    assertEquals(await h.drain(), []);
  },

  // ---- shared runtime ---------------------------------------------------------

  "shared runtime: a task created through the API is the application's task":
    async (h) => {
      const r = await h.call("POST", "/tasks", { title: "api first" });
      const viaApp = await h.runApp(h.app.getTask(r.json.id));
      assertEquals(viaApp, r.json);
      // ...and the other way round.
      const made = await h.runApp(h.app.createTask("app first"));
      assertEquals((await h.call("GET", `/tasks/${made.id}`)).json, made);
      assertEquals(
        (await h.call("GET", "/tasks")).json,
        await h.runApp(h.app.listTasks()),
      );
      await h.runApp(h.app.completeTask(made.id));
      assertEquals(
        (await h.call("GET", `/tasks/${made.id}`)).json.completed,
        true,
      );
    },

  "shared runtime: watchTasks on the same runtime sees API writes via the change stream":
    async (h) => {
      const snapshots: TasksSnapshot[] = [];
      const fiber = h.runtime.runFork(watchTasks((s) => snapshots.push(s)));
      const until = async (n: number) => {
        for (let i = 0; i < 400 && snapshots.length < n; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assertEquals(snapshots.length, n, "snapshot count");
      };
      try {
        await until(1);
        assertEquals(snapshots[0].tasks, SEED_TASKS);
        await h.call("POST", "/tasks", { title: "seen by the UI loop" });
        await until(2);
        assertEquals(snapshots[1].tasks.at(-1)?.title, "seen by the UI loop");
        assertEquals(snapshots[1].changes.map((c) => c.source), ["app"]);
        await h.call("DELETE", "/tasks/1");
        await until(3);
        assertFalse(snapshots[2].tasks.some((t) => t.id === 1));
        // A failed request changes nothing and reloads nothing.
        await h.call("DELETE", "/tasks/1");
        await new Promise((resolve) => setTimeout(resolve, 50));
        assertEquals(snapshots.length, 3);
      } finally {
        await h.runtime.runPromise(Fiber.interrupt(fiber));
      }
    },

  "shared runtime: no defect was reported by any case": (h) => {
    assertEquals(h.defects, []);
    return Promise.resolve();
  },
};

for (const backend of BACKENDS) {
  Deno.test(`task API on ${backend} (one shared runtime)`, async (t) => {
    await withApi(backend, async (h) => {
      for (const [name, body] of Object.entries(cases)) {
        await t.step(name, async () => {
          await Effect.runPromise(h.app.reset());
          await h.drain();
          await body(h);
        });
      }
    });
  });
}

Deno.test("task API: a defect in the application is a safe 500 InternalError", async () => {
  // A stub application whose listTasks dies; the rest of the API is untouched.
  const stub = {
    listTasks: () => Effect.die(new Error("secret stack detail")),
  } as unknown as TaskApplicationShape;
  const runtime = ManagedRuntime.make(
    Layer.succeed(TaskApplication)(stub),
  ) as unknown as ManagedRuntime.ManagedRuntime<TaskApiServices, unknown>;
  const defects: unknown[] = [];
  const handler = createTaskApiHandler(runtime, {
    onDefect: (cause) => defects.push(cause),
  });
  try {
    const r = await handler(new Request("https://api.invalid/tasks"));
    const text = await r.text();
    assertEquals(r.status, 500);
    assertEquals(JSON.parse(text).error.code, "InternalError");
    assertFalse(text.includes("secret"), text);
    assertEquals(defects.length, 1);
  } finally {
    await runtime.dispose();
  }
});

Deno.test("isSingleStatement: separators vs literals, identifiers and comments", () => {
  for (
    const ok of [
      "SELECT 1",
      "SELECT 1;",
      "SELECT 1 ;  \n",
      "SELECT ';'",
      "SELECT '''; DROP'",
      'SELECT 1 AS "x;y"',
      "SELECT 1 AS `x;y`",
      "SELECT 1 AS [x;y]",
      "SELECT 1; -- one\n-- two",
      "SELECT 1; /* ; */",
      "-- lead; \nSELECT 1",
      "/* a; b */ SELECT 1",
      "SELECT 'unterminated; ",
    ]
  ) assert(isSingleStatement(ok), ok);
  for (
    const bad of [
      "SELECT 1; SELECT 2",
      "SELECT 1;SELECT 2",
      "SELECT 1;;",
      "SELECT 1; -- c\nSELECT 2",
      "CREATE TRIGGER t AFTER INSERT ON tasks BEGIN SELECT 1; END",
      // Not SQLite whitespace: the engine would run the tail after the first
      // statement committed.
      "SELECT 1;\u00a0",
      "SELECT 1;\u00a0SELECT 2",
      "SELECT 1;\u3000",
      "SELECT 1;\u3000SELECT 2",
      "SELECT 1;\v",
      "SELECT 1;\vSELECT 2",
    ]
  ) assertFalse(isSingleStatement(bad), bad);
});
