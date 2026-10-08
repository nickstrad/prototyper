// R2: the reusable pieces on their own. `databaseCommand` only needs a §9
// DatabaseService (here a stub reporting engine "duckdb", so nothing SQLite
// specific leaks in); `mergeCommands` swaps R0's example `tasks` for the real
// one; `taskManagerTerminal` builds the runtime from the layer it is given,
// lazily, and turns a layer failure into stderr + exit 1.
import { assertEquals, assertMatch } from "@std/assert";
import { Data, Effect, Layer, ManagedRuntime, PubSub, Stream } from "effect";
import type {
  DatabaseError,
  DatabaseService,
  QueryResult,
} from "../../packages/core/types.ts";
import {
  databaseCommand,
  mergeCommands,
} from "../../packages/terminal/commands.ts";
import { createShell } from "../../packages/terminal/shell.ts";
import { exampleCommands } from "../../packages/terminal/examples/tasks-command.ts";
import { makeTasksRuntime } from "../../packages/terminal/examples/tasks.ts";
import {
  type TaskCommandsRuntime,
  taskManagerTerminal,
} from "../../prototypes/task-manager/commands.ts";
import {
  taskManagerLayerFromLookup,
  taskManagerLayerFromService,
} from "../../prototypes/task-manager/application.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import type { TaskApplication } from "../../prototypes/task-manager/application.ts";
import { SEED_TASKS } from "../../prototypes/task-manager/seed.ts";
import { backendLayer } from "../sqlite/harness.ts";

class StubError extends Data.TaggedError("DatabaseError")<{
  operation: DatabaseError["operation"];
  message: string;
  cause: unknown;
}> {}

const available = { available: true } as const;

/** A DuckDB-shaped stub: records calls, answers one fixed result. */
const stubService = (calls: string[]): DatabaseService => {
  const result: QueryResult = {
    columns: ["n", "h"],
    rows: [[18446744073709551615n, "x"]],
    changes: 0,
    schemaChanged: false,
    truncated: false,
  };
  return {
    engine: "duckdb",
    version: "v1.4.0",
    persistence: { requested: "opfs", actual: "memory", reason: "no OPFS" },
    capabilities: {
      persistence: available,
      multiTab: available,
      export: available,
      import: available,
      cancellation: available,
    },
    execute: (sql, options) =>
      Effect.sync(() => calls.push(`execute ${sql} ${JSON.stringify(options)}`))
        .pipe(Effect.as(result)),
    tables: () => Effect.succeed(["events", "users"]),
    schema: (table) =>
      Effect.fail(
        new StubError({
          operation: "schema",
          message: `no ${table}`,
          cause: null,
        }),
      ),
    reset: () => Effect.sync(() => void calls.push("reset")),
    exportBytes: () => Effect.succeed(new Uint8Array()),
    importBytes: () => Effect.void,
    subscribe: PubSub.unbounded<never>().pipe(Effect.flatMap(PubSub.subscribe)),
    changes: Stream.empty,
  };
};

Deno.test("R2 db command works on any DatabaseService (stub duckdb)", async () => {
  const calls: string[] = [];
  const service = stubService(calls);
  const runtime = ManagedRuntime.make(Layer.empty);
  try {
    const shell = createShell([
      databaseCommand(runtime, Effect.succeed(service), { name: "duck" }),
    ]);
    assertEquals(
      (await shell.exec("duck info")).stdout,
      "duckdb v1.4.0 · persistence memory (requested opfs: no OPFS)\n",
    );
    assertEquals((await shell.exec("duck tables")).stdout, "events\nusers\n");
    const sql = await shell.exec("duck sql --json select 1");
    assertEquals(JSON.parse(sql.stdout).rows, [[
      { $type: "bigint", value: "18446744073709551615" },
      "x",
    ]]);
    assertEquals(
      (await shell.exec("duck sql select 1")).stdout,
      "n\th\n18446744073709551615\tx\n",
    );
    const schema = await shell.exec("duck schema nope");
    assertEquals(
      [schema.stderr, schema.exitCode],
      ["duck: database error (schema): no nope\n", 1],
    );
    assertEquals((await shell.exec("duck reset")).exitCode, 0);
    const usage = await shell.exec("duck");
    assertEquals(usage.exitCode, 2);
    assertMatch(usage.stderr, /^usage: duck <command>\n {2}duck info/);
    assertEquals(calls, [
      'execute select 1 {"maxRows":1000,"source":"shell"}',
      'execute select 1 {"maxRows":1000,"source":"shell"}',
      "reset",
    ]);
  } finally {
    await runtime.dispose();
  }
});

Deno.test("R2 mergeCommands replaces R0's example tasks, keeps hello", async () => {
  const r0 = makeTasksRuntime();
  const terminal = taskManagerTerminal(() =>
    backendLayer("node:sqlite memory")
  );
  try {
    const merged = mergeCommands(exampleCommands(r0), terminal.commands);
    assertEquals(merged.map((c) => c.name), ["hello", "tasks", "db"]);
    const shell = createShell(merged);
    assertEquals((await shell.exec("hello R2")).stdout, "Hello, R2!\n");
    // The real application (seeded), not R0's empty in-memory example.
    assertEquals(
      JSON.parse((await shell.exec("tasks list --json")).stdout),
      SEED_TASKS,
    );
  } finally {
    await terminal.dispose();
    await r0.dispose();
  }
});

Deno.test("R2 taskManagerTerminal: lazy build, a failed build is stderr + exit 1 and retried", async () => {
  let builds = 0;
  const failing = taskManagerTerminal(() =>
    Layer.unwrap(Effect.suspend(() => {
      builds++;
      return Effect.fail(
        new StubError({
          operation: "open",
          message: "no shared database service on this page",
          cause: null,
        }),
      );
    }))
  );
  try {
    assertEquals(builds, 0, "nothing is built before the first command");
    const shell = createShell(failing.commands);
    // Usage errors never build the runtime.
    assertEquals((await shell.exec("tasks")).exitCode, 2);
    assertEquals(builds, 0);
    for (const [line, name] of [["tasks list", "tasks"], ["db tables", "db"]]) {
      const r = await shell.exec(line);
      assertEquals(r.exitCode, 1, line);
      assertEquals(r.stdout, "");
      assertEquals(
        r.stderr,
        `${name}: database error (open): no shared database service on this page\n`,
      );
    }
    assertEquals(builds, 2, "each failed build is replaced, not cached");
  } finally {
    await failing.dispose();
  }
});

Deno.test("R2 taskManagerTerminal: a service published after a lookup timeout is found by the next command", async () => {
  // The page's service, published only after the first lookup timed out.
  const owner = ManagedRuntime.make(
    backendLayer("node:sqlite memory").pipe(Layer.orDie),
  );
  let published: DatabaseService | undefined;
  const terminal = taskManagerTerminal(() =>
    taskManagerLayerFromLookup(() => published, {
      what: "test service",
      timeoutMs: 50,
      pollMs: 5,
    })
  );
  try {
    const shell = createShell(terminal.commands);
    const first = await shell.exec("tasks list");
    assertEquals(first.exitCode, 1);
    assertMatch(
      first.stderr,
      /^tasks: database error \(open\): no shared database service on this page: test service did not appear within 50 ms\n$/,
    );
    published = await owner.runPromise(Effect.service(Database));
    const second = await shell.exec("tasks list --json");
    assertEquals([second.exitCode, second.stderr], [0, ""]);
    assertEquals(JSON.parse(second.stdout), SEED_TASKS);
    // Same service as the owner's: a terminal write is visible there.
    assertEquals(
      (await shell.exec("tasks create Late")).stdout,
      "created 4: Late\n",
    );
    const rows = await owner.runPromise(
      Effect.flatMap(
        Effect.service(Database),
        (db) => db.execute("SELECT title FROM tasks WHERE id = 4"),
      ),
    );
    assertEquals(rows.rows, [["Late"]]);
  } finally {
    await terminal.dispose();
    await owner.dispose();
  }
});

// ---- taskManagerTerminal lifecycle ------------------------------------------

/** Runtimes the terminal made, in order, and whether each was disposed. */
const trackRuntimes = () => {
  const made: { disposed: boolean }[] = [];
  const makeRuntime = (
    layer: Layer.Layer<TaskApplication | Database>,
  ): TaskCommandsRuntime => {
    const rt = ManagedRuntime.make(layer);
    const record = { disposed: false };
    made.push(record);
    return new Proxy(rt, {
      get(target, key) {
        if (key === "dispose") {
          return () => {
            record.disposed = true;
            return target.dispose();
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return { made, makeRuntime };
};

const openFailure = (message: string) =>
  new StubError({ operation: "open", message, cause: null });

/** A layer whose first `failures` builds fail; later builds use node:sqlite. */
const flakyLayer = (failures: number, counter: { builds: number }) => () =>
  Layer.unwrap(Effect.suspend(() => {
    counter.builds++;
    return counter.builds <= failures
      ? Effect.fail(openFailure(`lookup ${counter.builds} timed out`))
      : Effect.succeed(backendLayer("node:sqlite memory"));
  }));

Deno.test("R2 lifecycle: a failed build is disposed and replaced; dispose() disposes the current runtime and sticks", async () => {
  const counter = { builds: 0 };
  const { made, makeRuntime } = trackRuntimes();
  const terminal = taskManagerTerminal(flakyLayer(1, counter), { makeRuntime });
  const shell = createShell(terminal.commands);
  try {
    const first = await shell.exec("tasks list");
    assertEquals(
      [first.exitCode, first.stderr],
      [1, "tasks: database error (open): lookup 1 timed out\n"],
    );
    assertEquals(
      made.map((r) => r.disposed),
      [true, false],
      "failed runtime disposed, a fresh one made",
    );
    const second = await shell.exec("tasks list --json");
    assertEquals(second.exitCode, 0);
    assertEquals(JSON.parse(second.stdout), SEED_TASKS);
    assertEquals(
      (await shell.exec("tasks create Kept")).stdout,
      "created 4: Kept\n",
    );
    // The commands use the new runtime, and keep using it (one build).
    assertEquals([counter.builds, made.length], [2, 2]);
    await terminal.dispose();
    assertEquals(
      made.map((r) => r.disposed),
      [true, true],
      "dispose() hits the current runtime",
    );
    for (const line of ["tasks list", "db tables", "tasks list"]) {
      const r = await shell.exec(line);
      assertEquals(r.exitCode, 1, line);
      assertMatch(
        r.stderr,
        /^(tasks|db): database error \(open\): terminal disposed\n$/,
      );
    }
    assertEquals(
      [counter.builds, made.length],
      [2, 2],
      "nothing is built after dispose()",
    );
  } finally {
    await terminal.dispose();
  }
});

Deno.test("R2 lifecycle: a defect on a healthy runtime is rethrown and the runtime kept", async () => {
  const counter = { builds: 0 };
  const { made, makeRuntime } = trackRuntimes();
  const service: DatabaseService = {
    ...stubService([]),
    execute: () => Effect.die(new Error("boom")),
  };
  const terminal = taskManagerTerminal(() =>
    Layer.unwrap(Effect.sync(() => {
      counter.builds++;
      return taskManagerLayerFromService(service);
    })), { makeRuntime });
  const shell = createShell(terminal.commands);
  try {
    const r = await shell.exec("db sql select 1");
    assertEquals([r.exitCode, r.stdout, r.stderr], [1, "", "db: boom\n"]);
    assertEquals((await shell.exec("db tables")).stdout, "events\nusers\n");
    assertEquals([counter.builds, made.length], [1, 1]);
    assertEquals(made[0].disposed, false, "the healthy runtime is kept");
  } finally {
    await terminal.dispose();
  }
});

Deno.test("R2 lifecycle: a command in flight when dispose() runs reports disposal and builds nothing", async () => {
  const counter = { builds: 0 };
  const { made, makeRuntime } = trackRuntimes();
  const terminal = taskManagerTerminal(() =>
    Layer.unwrap(Effect.suspend(() => {
      counter.builds++;
      return Effect.as(Effect.sleep(200), backendLayer("node:sqlite memory"));
    })), { makeRuntime });
  const shell = createShell(terminal.commands);
  const pending = shell.exec("tasks list");
  await new Promise((r) => setTimeout(r, 20));
  await terminal.dispose();
  const r = await pending;
  assertEquals(
    [r.exitCode, r.stdout, r.stderr],
    [1, "", "tasks: database error (open): terminal disposed\n"],
  );
  assertEquals((await shell.exec("tasks list")).exitCode, 1);
  assertEquals([counter.builds, made.length], [1, 1], "no rebuild");
  assertEquals(made[0].disposed, true);
});

Deno.test("R2 lifecycle: concurrent commands on one failed build all report it; one rebuild", async () => {
  const counter = { builds: 0 };
  const { made, makeRuntime } = trackRuntimes();
  const terminal = taskManagerTerminal(flakyLayer(1, counter), { makeRuntime });
  try {
    const results = await Promise.all(
      [0, 1, 2].map(() => createShell(terminal.commands).exec("tasks list")),
    );
    for (const r of results) {
      assertEquals(
        [r.exitCode, r.stderr],
        [1, "tasks: database error (open): lookup 1 timed out\n"],
      );
    }
    assertEquals(made.length, 2, "one replacement runtime");
    assertEquals(
      (await createShell(terminal.commands).exec("tasks get 1")).exitCode,
      0,
    );
  } finally {
    await terminal.dispose();
  }
});

Deno.test("R2 lifecycle: dispose() before any command: nothing is ever built", async () => {
  const counter = { builds: 0 };
  const { made, makeRuntime } = trackRuntimes();
  const terminal = taskManagerTerminal(flakyLayer(0, counter), { makeRuntime });
  await terminal.dispose();
  const shell = createShell(terminal.commands);
  for (const line of ["tasks list", "db tables"]) {
    const r = await shell.exec(line);
    assertEquals(r.exitCode, 1, line);
    assertMatch(r.stderr, /database error \(open\): terminal disposed\n$/);
  }
  assertEquals([counter.builds, made.length], [0, 1]);
  assertEquals(made[0].disposed, true);
});
