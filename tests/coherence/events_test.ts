// packages/core/events.ts against a real service: the observer never waits,
// sees exactly one change per successful write and none per read or failure;
// failures classify the same way the CLI and API render them; snapshots
// compare state across interfaces and prove a reset restores the exact seed.
import { assert, assertEquals } from "@std/assert";
import { Effect, Exit } from "effect";
import {
  CHANGE_SOURCES,
  CoherenceTimeout,
  diffSnapshot,
  sameSnapshot,
  summarizeFailure,
} from "../../packages/core/events.ts";
import { BACKENDS, withInstance } from "./harness.ts";

Deno.test("observer: one change per write, none per read or failure, drain never waits", async (t) => {
  for (const backend of BACKENDS) {
    await t.step(backend, () =>
      withInstance(backend, async (i) => {
        assertEquals(await i.run(i.observer.drain()), []);
        await i.run(i.app.listTasks());
        assertEquals((await i.run(i.observer.drain())).length, 0);
        await i.run(i.app.createTask("one"));
        const first = await i.run(i.observer.drain());
        assertEquals(
          first.map((o) => [o.seq, o.change.source, o.change.kind]),
          [
            [1, "app", "write"],
          ],
        );
        const exit = await Effect.runPromiseExit(i.app.createTask(""));
        assert(Exit.isFailure(exit));
        assertEquals((await i.run(i.observer.drain())).length, 0);
        await i.run(i.app.completeTask(4));
        await i.run(i.app.deleteTask(4));
        assertEquals((await i.run(i.observer.drain())).length, 2);
        assertEquals(i.observer.countBySource(), { app: 3, shell: 0, host: 0 });
        assertEquals(i.observer.since(2).map((o) => o.seq), [3]);
      }));
  }
});

Deno.test("observer.waitFor finds a change drained earlier and times out with CoherenceTimeout", async () => {
  await withInstance("node:sqlite memory", async (i) => {
    await i.run(i.app.createTask("early"));
    const hit = await i.run(
      i.observer.waitFor((c) => c.source === "app", { timeoutMs: 500 }),
    );
    assertEquals(hit.seq, 1);
    const started = performance.now();
    const exit = await Effect.runPromiseExit(
      i.observer.waitFor((c) => c.source === "host", {
        timeoutMs: 120,
        pollMs: 5,
      }),
    );
    assert(Exit.isFailure(exit));
    const error = await Effect.runPromise(
      Effect.flip(
        i.observer.waitFor((c) => c.source === "host", { timeoutMs: 20 }),
      ),
    );
    assert(error instanceof CoherenceTimeout);
    assertEquals(error.observed.length, 1);
    assert(performance.now() - started >= 100);
  });
});

Deno.test("summarizeFailure classifies every interface-visible failure", () => {
  const table = [
    [
      { _tag: "InvalidInput", message: "title is required" },
      "invalid-input",
      400,
    ],
    [
      { _tag: "TaskNotFound", id: 9, message: "Task 9 not found" },
      "not-found",
      404,
    ],
    [{ _tag: "CorruptTask", ids: ["1"], message: "row 1" }, "corrupt", 500],
    [
      { _tag: "DatabaseError", operation: "execute", message: "no such table" },
      "database",
      500,
    ],
    [
      { _tag: "ShellError", operation: "submit", message: "busy" },
      "shell",
      500,
    ],
    [new Error("boom"), "defect", 500],
    ["plain string", "defect", 500],
  ] as const;
  for (const [error, kind, status] of table) {
    const s = summarizeFailure(error);
    assertEquals([s.kind, s.httpStatus, s.exitCode], [kind, status, 1]);
    assert(s.message.length > 0);
  }
  assertEquals(summarizeFailure(new Error("boom")).tag, "Defect");
  assertEquals(CHANGE_SOURCES, ["app", "shell", "host"]);
});

Deno.test("snapshot: equal across readers, differs after a write, reset restores the exact seed", async (t) => {
  for (const backend of BACKENDS) {
    await t.step(backend, () =>
      withInstance(backend, async (i) => {
        const seed = await i.snap();
        assertEquals(Object.keys(seed), ["tasks"]);
        assertEquals(seed.tasks.rows.length, 3);
        assertEquals(seed.tasks.columns, [
          "id",
          "title",
          "completed",
          "created_at",
        ]);
        assert(sameSnapshot(seed, await i.snap()));
        await i.run(i.app.createTask("changed"));
        const after = await i.snap();
        assert(!sameSnapshot(seed, after));
        const diff = diffSnapshot(seed, after);
        assert(diff !== null && diff.startsWith("table tasks differs"));
        await i.run(i.app.reset());
        const restored = await i.snap();
        assertEquals(diffSnapshot(seed, restored), null);
        // Reset is a change of kind "reset" from the host, exactly once.
        const log = await i.run(i.observer.drain());
        assertEquals(log.map((o) => o.change.kind), ["write", "reset"]);
      }));
  }
  await withInstance("node:sqlite memory", async (i) => {
    await i.run(
      i.db.execute("CREATE TABLE wide(a); INSERT INTO wide VALUES (1)"),
    );
    assertEquals(Object.keys(await i.snap()), ["tasks", "wide"]);
  });
});

Deno.test("snapshot orders rows by the first column, encodes bigint and blob cells, and keeps 1201 rows", async () => {
  await withInstance("node:sqlite memory", async (i) => {
    await i.run(i.db.execute(
      "CREATE TABLE odd(id INTEGER, big INTEGER, blob BLOB); " +
        "INSERT INTO odd VALUES (3, 9007199254740993, x'00ff10'), (1, 2, NULL), (2, NULL, x'')",
    ));
    const s = await i.snap();
    assertEquals(s.odd.rows.map((r) => r[0]), [1, 2, 3]);
    assertEquals(s.odd.rows[2], [3, {
      $type: "bigint",
      value: "9007199254740993",
    }, {
      $type: "blob",
      base64: "AP8Q",
    }]);
    assertEquals(s.odd.rows[1], [2, null, { $type: "blob", base64: "" }]);
    assertEquals(JSON.parse(JSON.stringify(s.odd)), s.odd);
    // Rows beyond the services' default 1000-row cap are still held in full.
    await i.run(i.db.execute(
      "CREATE TABLE many(n INTEGER); " +
        "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 1201) INSERT INTO many SELECT n FROM c",
    ));
    const big = (await i.snap()).many;
    assertEquals(big.rows.length, 1201);
    assertEquals(big.truncated, undefined);
    assertEquals(big.rows[1200], [1201]);
  });
});

Deno.test("sameSnapshot/diffSnapshot: one-sided tables and truncated tables never compare equal", () => {
  const a = { t: { columns: ["x"], rows: [[1]] } };
  const b = {
    t: { columns: ["x"], rows: [[1]] },
    u: { columns: ["y"], rows: [] },
  };
  assert(!sameSnapshot(a, b));
  assertEquals(diffSnapshot(a, b), "table u present on one side only");
  const t = { t: { columns: ["x"], rows: [[1]], truncated: true as const } };
  assert(!sameSnapshot(t, t));
  assert(!sameSnapshot(a, t));
  assertEquals(
    diffSnapshot(a, t),
    "table t is truncated on one side; cannot compare",
  );
  assertEquals(diffSnapshot(a, a), null);
});

Deno.test("waitFor budgets from when it runs, and reports the elapsed wait", async () => {
  await withInstance("node:sqlite memory", async (i) => {
    // Built now, run 300 ms later, change arriving 100 ms into the run.
    const wait = i.observer.waitFor((c) => c.source === "app", {
      timeoutMs: 250,
      pollMs: 5,
    });
    await new Promise((r) => setTimeout(r, 300));
    setTimeout(() => void i.run(i.app.createTask("late")), 100);
    const hit = await i.run(wait);
    assertEquals(hit.change.source, "app");
    // The same effect run again gets a fresh budget and the already-drained hit.
    assertEquals((await i.run(wait)).seq, hit.seq);
    const started = performance.now();
    const error = await i.run(
      Effect.flip(
        i.observer.waitFor((c) => c.source === "host", {
          timeoutMs: 60,
          pollMs: 5,
        }),
      ),
    );
    const elapsed = performance.now() - started;
    assert(
      error.waitedMs >= 55 && error.waitedMs <= elapsed + 1,
      `waitedMs ${error.waitedMs} vs ${elapsed}`,
    );
  });
});

Deno.test("countBySource attributes app, shell and host changes", async () => {
  await withInstance("node:sqlite memory", async (i) => {
    await i.run(i.app.createTask("app write"));
    const sh = await i.cli(
      `db sql "INSERT INTO tasks (title, completed, created_at) VALUES ('shell write', 0, 'x')"`,
    );
    assertEquals(sh.exitCode, 0, sh.stderr);
    await i.run(i.app.reset());
    await i.run(i.observer.drain());
    assertEquals(i.observer.countBySource(), { app: 1, shell: 1, host: 1 });
    assertEquals(i.observer.log.map((o) => o.change.source), [
      "app",
      "shell",
      "host",
    ]);
  });
});
