// R2 native suite: `tasks` and `db` as just-bash commands on the task
// manager's shared runtime, over node:sqlite and sqlite-wasm memory. Output
// formats, typed failures (stderr + nonzero exit), the jq pipeline, reset to
// the exact seed, and that every terminal write reaches the app and the
// change stream the UI re-renders from.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Effect, Fiber } from "effect";
import {
  TaskApplication,
  type TasksSnapshot,
  watchTasks,
} from "../../prototypes/task-manager/application.ts";
import { TASKS_TABLE_SQL } from "../../prototypes/task-manager/schema.ts";
import { SEED_TASKS } from "../../prototypes/task-manager/seed.ts";
import { TASKS_USAGE } from "../../prototypes/task-manager/commands.ts";
import { DB_SQL_MAX_ROWS } from "../../packages/terminal/commands.ts";
import { BACKENDS, type CliHarness, CLOCK_START, withCli } from "./harness.ts";

const at = (seconds: number) =>
  new Date(Date.parse(CLOCK_START) + seconds * 1000).toISOString();

const listJson = async (h: CliHarness) => {
  const r = await h.sh("tasks list --json");
  assertEquals([r.exitCode, r.stderr], [0, ""]);
  return JSON.parse(r.stdout);
};

/** Expects a failure: exact stderr, empty stdout, the given exit code. */
const fails = async (
  h: CliHarness,
  line: string,
  stderr: string | RegExp,
  exitCode = 1,
) => {
  const r = await h.sh(line);
  assertEquals(r.exitCode, exitCode, `${line}: exit code`);
  assertEquals(r.stdout, "", `${line}: stdout`);
  if (typeof stderr === "string") assertEquals(r.stderr, stderr, line);
  else assert(stderr.test(r.stderr), `${line}: stderr was ${r.stderr}`);
};

const cases: Record<string, (h: CliHarness) => Promise<void>> = {
  "tasks list/get: text, --json and the jq pipeline": async (h) => {
    assertEquals(
      (await h.sh("tasks list")).stdout,
      "1\t[x] Write the project plan\n" +
        "2\t[ ] Probe SQLite WASM\n" +
        "3\t[ ] Wire the terminal\n",
    );
    assertEquals(await listJson(h), SEED_TASKS);
    const jq = await h.sh("tasks list --json | jq '.[].title'");
    assertEquals(jq.exitCode, 0);
    assertEquals(
      jq.stdout,
      '"Write the project plan"\n"Probe SQLite WASM"\n"Wire the terminal"\n',
    );
    assertEquals(
      (await h.sh("tasks list --json | jq -r '.[] | select(.completed) | .id'"))
        .stdout,
      "1\n",
    );
    assertEquals(
      (await h.sh("tasks get 2")).stdout,
      "2\t[ ] Probe SQLite WASM\n",
    );
    assertEquals(
      JSON.parse((await h.sh("tasks get --json 2")).stdout),
      SEED_TASKS[1],
    );
    await h.settle();
    assertEquals(h.events, [], "reads publish nothing");
  },

  "tasks create/complete/update/delete write through the shared app": async (
    h,
  ) => {
    const created = await h.sh('tasks create "Build  API"');
    assertEquals(created, {
      stdout: "created 4: Build  API\n",
      stderr: "",
      exitCode: 0,
    });
    // Words are joined; the title is trimmed by the app's schema.
    assertEquals(
      (await h.sh("tasks create  Write   tests ")).stdout,
      "created 5: Write tests\n",
    );
    const asJson = JSON.parse(
      (await h.sh("tasks create --json -- --json flag")).stdout,
    );
    assertEquals(asJson, {
      id: 6,
      title: "--json flag",
      completed: false,
      createdAt: at(2),
    });
    assertEquals(await h.run(h.app.getTask(4)), {
      id: 4,
      title: "Build  API",
      completed: false,
      createdAt: at(0),
    });
    assertEquals(
      (await h.sh("tasks complete 4")).stdout,
      "completed 4: Build  API\n",
    );
    assertEquals((await h.run(h.app.getTask(4))).completed, true);
    assertEquals(
      (await h.sh("tasks update 4 --title 'Build the API' --completed false"))
        .stdout,
      "updated 4: Build the API\n",
    );
    assertEquals(await h.run(h.app.getTask(4)), {
      id: 4,
      title: "Build the API",
      completed: false,
      createdAt: at(0),
    });
    assertEquals(
      (await h.sh("tasks delete 5")).stdout,
      "deleted 5: Write tests\n",
    );
    assertEquals(
      (await h.sh("tasks list --json | jq -r '.[].id'")).stdout,
      "1\n2\n3\n4\n6\n",
    );
    // A task created by the app shows up in the terminal (one service).
    await h.run(h.app.createTask("From the UI"));
    assertStringIncludes(
      (await h.sh("tasks list")).stdout,
      "7\t[ ] From the UI\n",
    );
    await h.settle();
    assertEquals(
      h.events.map((e) => [e.kind, e.source, e.changes]),
      Array(7).fill(["write", "app", 1]),
      "one change event per terminal write",
    );
  },

  "typed failures: stderr + exit 1, nothing written": async (h) => {
    await fails(
      h,
      'tasks create ""',
      "tasks: invalid input: title is required\n",
    );
    await fails(
      h,
      "tasks create '   '",
      "tasks: invalid input: title is required\n",
    );
    await fails(
      h,
      `tasks create ${"x".repeat(201)}`,
      "tasks: invalid input: title must be at most 200 characters\n",
    );
    await fails(h, "tasks complete 42", "tasks: task 42 not found\n");
    await fails(h, "tasks delete 42", "tasks: task 42 not found\n");
    await fails(h, "tasks get 42", "tasks: task 42 not found\n");
    await fails(
      h,
      "tasks update 42 --completed true",
      "tasks: task 42 not found\n",
    );
    await fails(
      h,
      "tasks complete abc",
      'tasks: invalid input: id must be an integer, got "abc"\n',
    );
    await fails(
      h,
      "tasks complete 1.5",
      'tasks: invalid input: id must be an integer, got "1.5"\n',
    );
    await fails(
      h,
      "tasks complete ''",
      'tasks: invalid input: id must be an integer, got ""\n',
    );
    await fails(
      h,
      "tasks get 0",
      "tasks: invalid input: id must be positive\n",
    );
    await fails(
      h,
      "tasks get -3",
      "tasks: invalid input: id must be positive\n",
    );
    await fails(
      h,
      "tasks get 99999999999999999999",
      "tasks: invalid input: id is too large\n",
    );
    await fails(
      h,
      "tasks get -99999999999999999999",
      "tasks: invalid input: id is too large\n",
    );
    await fails(
      h,
      "tasks update 1 --completed maybe",
      'tasks: invalid input: --completed expects true or false, got "maybe"\n',
    );
    await fails(
      h,
      "tasks update 1 --title ''",
      "tasks: invalid input: title is required\n",
    );
    await fails(
      h,
      "tasks update 1 --colour red",
      /^tasks: invalid input: unexpected argument "--colour"/,
    );
    // The shell sees the status: ||, $? and set -e behave.
    assertEquals(
      (await h.sh("tasks complete 42 || echo recovered")).stdout,
      "recovered\n",
    );
    assertEquals(
      (await h.sh("tasks complete 42 2>/dev/null; echo $?")).stdout,
      "1\n",
    );
    assertEquals(
      (await h.sh("tasks complete 2 && echo ok")).stdout,
      "completed 2: Probe SQLite WASM\nok\n",
    );
    await h.settle();
    assertEquals(h.events.length, 1, "only the successful complete wrote");
    assertEquals((await listJson(h)).length, 3);
  },

  "usage errors exit 2 with the usage text": async (h) => {
    for (
      const line of [
        "tasks",
        "tasks bogus",
        "tasks get",
        "tasks get 1 2",
        "tasks complete",
        "tasks create",
        "tasks list extra",
        "tasks update 1",
        "tasks update 1 --title",
      ]
    ) await fails(h, line, TASKS_USAGE, 2);
    await fails(h, "db", /^usage: db <command>/, 2);
    await fails(h, "db bogus", /^usage: db <command>/, 2);
    await fails(
      h,
      "db schema",
      /^db schema: expected exactly one TABLE\nusage: db/,
      2,
    );
    await fails(
      h,
      "db schema tasks extra",
      /^db schema: expected exactly one TABLE\nusage: db/,
      2,
    );
    await fails(
      h,
      "db schema --json tasks",
      /^db schema: expected exactly one TABLE\nusage: db/,
      2,
    );
    await fails(h, "db reset now", /^db reset: unexpected arguments\n/, 2);
    await fails(h, "db sql", /^db sql: no SQL given/, 2);
  },

  "CorruptTask and DatabaseError reach stderr through tasks": async (h) => {
    const insert = await h.sh(
      `db sql "INSERT INTO tasks (id, title, completed, created_at) VALUES (9, 'bad', 7, 'x')"`,
    );
    assertEquals(insert, { stdout: "changes: 1\n", stderr: "", exitCode: 0 });
    await fails(
      h,
      "tasks list",
      /^tasks: stored data the app cannot read \(task 9: .*\); fix or delete it with SQL, or reset\n$/,
    );
    await fails(
      h,
      "tasks complete 9",
      /^tasks: stored data the app cannot read \(task 9/,
    );
    assertEquals((await h.sh("db sql 'DROP TABLE tasks'")).exitCode, 0);
    await fails(
      h,
      "tasks list",
      /^tasks: database error \(execute\): .*no such table: tasks/,
    );
    await fails(h, "db schema tasks", /^db: database error \(schema\): /);
    await fails(
      h,
      "db sql 'SELECT * FROM nope'",
      /^db: database error \(execute\): .*no such table: nope/,
    );
  },

  "db tables/schema/info/sql on the shared DatabaseService": async (h) => {
    assertEquals((await h.sh("db tables")).stdout, "tasks\n");
    assertEquals(JSON.parse((await h.sh("db tables --json")).stdout), [
      "tasks",
    ]);
    assertEquals(
      (await h.sh("db schema tasks")).stdout,
      TASKS_TABLE_SQL + "\n",
    );
    // One quoted argument is one table name, spaces and quotes included;
    // the name is never spliced into SQL.
    assertEquals(
      (await h.sh(`db sql 'CREATE TABLE "my table" (x)'`)).exitCode,
      0,
    );
    assertEquals(
      (await h.sh(`db schema "my table"`)).stdout,
      'CREATE TABLE "my table" (x)\n',
    );
    await fails(
      h,
      `db schema "tasks; DROP TABLE tasks; --"`,
      "db: database error (schema): no such table: tasks; DROP TABLE tasks; --\n",
    );
    await fails(
      h,
      `db schema "x' OR '1'='1"`,
      "db: database error (schema): no such table: x' OR '1'='1\n",
    );
    assertEquals((await h.sh("db tables")).stdout, "my table\ntasks\n");
    // TSV text output escapes tab, newline, CR and backslash in cells and
    // column names; --json keeps the exact values.
    // Shell input: SELECT 'a' || char(9) || 'b' AS "t\b", ... AS nl,
    // 'c:\dir' AS bs (one literal backslash in the alias and the value).
    const tsv = String.raw`db sql "SELECT 'a' || char(9) || 'b' AS \"t\b\", ` +
      String.raw`'l1' || char(10) || 'l2' || char(13) AS nl, 'c:\dir' AS bs"`;
    assertEquals(
      (await h.sh(tsv)).stdout,
      String.raw`t\\b` + "\tnl\tbs\n" +
        String.raw`a\tb` + "\t" + String.raw`l1\nl2\r` + "\t" +
        String.raw`c:\\dir` + "\n",
    );
    assertEquals(
      JSON.parse((await h.sh(tsv.replace("db sql", "db sql --json"))).stdout)
        .rows,
      [["a\tb", "l1\nl2\r", "c:\\dir"]],
    );
    await h.settle();
    h.events.length = 0; // the CREATE TABLE above was a (schema) write
    const info = JSON.parse((await h.sh("db info --json")).stdout);
    assertEquals(info.engine, "sqlite");
    assertEquals(info.version, h.db.version);
    assertEquals(info.persistence.actual, "memory");
    assertEquals(
      (await h.sh("db sql SELECT id, title FROM tasks WHERE completed = 1"))
        .stdout,
      "id\ttitle\n1\tWrite the project plan\n",
    );
    // Cells: bigint and blob through encodeCell; NULL and floats as JSON.
    const cells = JSON.parse(
      (await h.sh(
        `db sql --json "SELECT 9007199254740993 AS big, x'00ff' AS b, NULL AS n, 1.5 AS f, 'a' AS a, 'a' AS a"`,
      )).stdout,
    );
    assertEquals(cells, {
      columns: ["big", "b", "n", "f", "a", "a"],
      rows: [[
        { $type: "bigint", value: "9007199254740993" },
        { $type: "blob", base64: "AP8=" },
        null,
        1.5,
        "a",
        "a",
      ]],
      changes: 0,
      schemaChanged: false,
      truncated: false,
    });
    assertEquals(
      (await h.sh(`db sql "SELECT 9007199254740993, x'00ff', NULL"`)).stdout
        .split("\n")[1],
      "9007199254740993\tx'00ff'\tNULL",
    );
    // SQL from stdin; a write through db sql is visible to the app.
    assertEquals(
      (await h.sh(
        `echo "UPDATE tasks SET title = 'Via db' WHERE id = 3" | db sql`,
      )).stdout,
      "changes: 1\n",
    );
    assertEquals((await h.run(h.app.getTask(3))).title, "Via db");
    await h.settle();
    assertEquals(h.events.map((e) => [e.kind, e.source, e.changes]), [[
      "write",
      "shell",
      1,
    ]]);
    // A truncated result says so on stderr but still succeeds.
    const many = await h.sh(
      `db sql "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${
        DB_SQL_MAX_ROWS + 5
      }) SELECT i FROM n"`,
    );
    assertEquals(many.exitCode, 0);
    assertEquals(many.stdout.trimEnd().split("\n").length, DB_SQL_MAX_ROWS + 1);
    assertEquals(
      many.stderr,
      `db sql: output truncated to ${DB_SQL_MAX_ROWS} rows\n`,
    );
  },

  "db reset restores exactly the seed on the same service": async (h) => {
    await h.sh("tasks create Extra");
    await h.sh("tasks delete 1");
    await h.sh("tasks update 2 --title Renamed --completed true");
    await h.sh("db sql 'CREATE TABLE junk (x)'");
    await h.sh(
      "db sql \"INSERT INTO tasks (title, completed, created_at) VALUES ('raw', 3, 'x')\"",
    );
    await h.settle();
    h.events.length = 0;
    const r = await h.sh("db reset");
    assertEquals(r, {
      stdout: "database reset to its seed data\n",
      stderr: "",
      exitCode: 0,
    });
    assertEquals(await listJson(h), SEED_TASKS);
    assertEquals((await h.sh("db tables")).stdout, "tasks\n");
    assertEquals(
      await h.run(h.app.listTasks()),
      SEED_TASKS,
      "the app sees the reset",
    );
    await h.settle();
    assertEquals(h.events.map((e) => e.kind), ["reset"]);
    // New ids continue from the seed again.
    assertEquals(
      (await h.sh("tasks create Again")).stdout,
      "created 4: Again\n",
    );
  },

  "terminal writes drive the UI's change-stream reload": async (h) => {
    const snapshots: TasksSnapshot[] = [];
    const fiber = Effect.runFork(
      watchTasks((s) => snapshots.push(s)).pipe(
        Effect.provideService(TaskApplication, h.app),
      ),
    );
    const until = async (n: number) => {
      for (let i = 0; i < 200 && snapshots.length < n; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assertEquals(snapshots.length, n, "snapshot count");
    };
    try {
      await until(1);
      await h.sh("tasks create 'From the terminal'");
      await until(2);
      assertEquals(snapshots[1].tasks.at(-1)?.title, "From the terminal");
      assertEquals(snapshots[1].changes.map((c) => c.kind), ["write"]);
      await h.sh("tasks list --json | jq length"); // reads: no reload
      await h.sh("tasks complete 404"); // failure: no reload
      await new Promise((r) => setTimeout(r, 50));
      assertEquals(snapshots.length, 2);
      await h.sh("db reset");
      await until(3);
      assertEquals(snapshots[2].tasks, SEED_TASKS);
      assertEquals(snapshots[2].changes.map((c) => c.kind), ["reset"]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  },
};

for (const backend of BACKENDS) {
  for (const [name, body] of Object.entries(cases)) {
    Deno.test(`R2 ${backend}: ${name}`, () => withCli(backend, body));
  }
}
