// Coherence across interfaces on one prototype instance (R4 done-when,
// native half): CLI create -> API complete -> application list and raw SQL
// agree; a raw-SQL ("shell") write is visible to the CLI, the API and the
// application; reset through any interface restores the exact seed; every
// interface classifies the same failure the same way; and exactly one change
// is published per successful write, none per failure.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Effect } from "effect";
import { sameSnapshot, summarizeFailure } from "../../packages/core/events.ts";
import { SEED_TASKS } from "../../prototypes/task-manager/seed.ts";
import { BACKENDS, forEachBackend, type Instance } from "./harness.ts";

const titles = (rows: readonly { title: string }[]) => rows.map((r) => r.title);

const seedSnapshotOf = async (i: Instance) => {
  await i.run(i.app.reset());
  await i.run(i.observer.drain());
  return await i.snap();
};

Deno.test("CLI create -> API complete -> UI core and raw SQL agree", (t) =>
  forEachBackend(t, BACKENDS, async (i) => {
    const created = await i.cli('tasks create "Coherence task"');
    assertEquals(created.exitCode, 0, created.stderr);
    assertStringIncludes(created.stdout, "Coherence task");
    const id = Number(/created (\d+)/.exec(created.stdout)?.[1]);
    assertEquals(id, SEED_TASKS.length + 1);

    const completed = await i.api("POST", `/tasks/${id}/complete`);
    assertEquals(completed.status, 200, completed.text);
    assertEquals(completed.json.completed, true);

    // Web UI core (application), raw SQL (what the editor console sees) and
    // the CLI's JSON listing all show the same row.
    const fromApp = (await i.run(i.app.listTasks())).find((x) => x.id === id);
    assertEquals(fromApp?.completed, true);
    const raw = await i.run(
      i.db.execute(`SELECT title, completed FROM tasks WHERE id = ${id}`),
    );
    assertEquals(raw.rows, [["Coherence task", 1]]);
    const cliList = await i.cli("tasks list --json");
    const viaCli = JSON.parse(cliList.stdout).find((x: { id: number }) =>
      x.id === id
    );
    assertEquals(viaCli.completed, true);
    const viaApi = await i.api("GET", `/tasks/${id}`);
    assertEquals(viaApi.json.title, "Coherence task");

    // Exactly one notification per write, both attributed to the app.
    const log = await i.run(i.observer.drain());
    assertEquals(log.map((o) => [o.change.source, o.change.kind]), [
      ["app", "write"],
      ["app", "write"],
    ]);
  }));

Deno.test("a shell-style raw write is visible to CLI, API and UI core with one notification", (t) =>
  forEachBackend(t, BACKENDS, async (i) => {
    // `db sql` is the application terminal's raw-SQL command (source "shell").
    const r = await i.cli(
      `db sql "INSERT INTO tasks (title, completed, created_at) VALUES ('From shell', 0, '2026-10-08T10:00:00.000Z')"`,
    );
    assertEquals(r.exitCode, 0, r.stderr);
    const viaApi = await i.api("GET", "/tasks");
    assert(titles(viaApi.json).includes("From shell"));
    const viaApp = await i.run(i.app.listTasks());
    assert(titles(viaApp).includes("From shell"));
    const viaCli = JSON.parse((await i.cli("tasks list --json")).stdout);
    assert(titles(viaCli).includes("From shell"));
    const log = await i.run(i.observer.drain());
    assertEquals(
      log.map((o) => [o.change.source, o.change.kind, o.change.changes]),
      [
        ["shell", "write", 1],
      ],
    );
  }));

Deno.test("reset through CLI, API or the application restores the exact seed", (t) =>
  forEachBackend(t, BACKENDS, async (i) => {
    const seed = await seedSnapshotOf(i);
    for (const via of ["cli", "api", "app"] as const) {
      await i.cli('tasks create "temporary"');
      await i.run(i.db.execute("CREATE TABLE stray(x)"));
      assert(!sameSnapshot(seed, await i.snap()));
      await i.run(i.observer.drain());
      if (via === "cli") {
        const r = await i.cli("db reset");
        assertEquals(r.exitCode, 0, r.stderr);
      } else if (via === "api") {
        assertEquals((await i.api("POST", "/reset")).status, 200);
      } else {
        await i.run(i.app.reset());
      }
      assert(sameSnapshot(seed, await i.snap()), `reset via ${via}`);
      // Ids restart after the seed: the next create is id 4 again.
      const next = await i.api("POST", "/tasks", { title: "after reset" });
      assertEquals(next.json.id, SEED_TASKS.length + 1);
      const log = await i.run(i.observer.drain());
      assertEquals(log.map((o) => o.change.kind), ["reset", "write"]);
      assertEquals(log[0].change.source, "host");
    }
  }));

Deno.test("every interface classifies the same failure the same way and publishes nothing", (t) =>
  forEachBackend(t, BACKENDS, async (i) => {
    await i.run(i.observer.drain());
    // Invalid input: blank title.
    const appInvalid = await Effect.runPromise(
      Effect.flip(i.app.createTask("   ")),
    );
    const invalidSummary = summarizeFailure(appInvalid);
    assertEquals(invalidSummary.kind, "invalid-input");
    const cliInvalid = await i.cli('tasks create "   "');
    const apiInvalid = await i.api("POST", "/tasks", { title: "   " });
    assertEquals(cliInvalid.exitCode, 1);
    assertStringIncludes(cliInvalid.stderr.toLowerCase(), "invalid input");
    assertEquals(apiInvalid.status, 400);
    assertEquals(apiInvalid.json.error.code, "InvalidInput");
    assertEquals([invalidSummary.exitCode, invalidSummary.httpStatus], [
      cliInvalid.exitCode,
      apiInvalid.status,
    ]);

    // Not found.
    const cliMissing = await i.cli("tasks complete 404");
    const apiMissing = await i.api("POST", "/tasks/404/complete");
    const appMissing = await Effect.runPromise(
      Effect.flip(i.app.completeTask(404)),
    );
    const missingSummary = summarizeFailure(appMissing);
    assertEquals(missingSummary.kind, "not-found");
    assertEquals(cliMissing.exitCode, missingSummary.exitCode);
    assertEquals(apiMissing.status, missingSummary.httpStatus);
    assertStringIncludes(cliMissing.stderr, "404");

    // Corrupt row the application cannot read (written around the app).
    await i.run(i.db.execute("UPDATE tasks SET completed = 7 WHERE id = 2"));
    await i.run(i.observer.drain());
    const cliCorrupt = await i.cli("tasks complete 2");
    const apiCorrupt = await i.api("POST", "/tasks/2/complete");
    const appCorrupt = await Effect.runPromise(
      Effect.flip(i.app.completeTask(2)),
    );
    const corruptSummary = summarizeFailure(appCorrupt);
    assertEquals(corruptSummary.kind, "corrupt");
    assertEquals(cliCorrupt.exitCode, 1);
    assertEquals(apiCorrupt.status, 500);
    assertEquals(apiCorrupt.json.error.code, "CorruptTask");
    // The row is untouched and nothing was published by any of the failures.
    const row = await i.run(
      i.db.execute("SELECT completed FROM tasks WHERE id = 2"),
    );
    assertEquals(row.rows, [[7]]);
    assertEquals(await i.run(i.observer.drain()), []);
  }));

Deno.test("CLI, API and UI core use one service: identity and state", (t) =>
  forEachBackend(t, BACKENDS, async (i) => {
    const viaRuntime = await i.runtime.runPromise(
      Effect.map(
        Effect.service(
          (await import("../../packages/database/sqlite-service.ts")).Database,
        ),
        (db) => db,
      ),
    );
    assert(viaRuntime === i.db);
    const cliJson = JSON.parse(
      (await i.cli("db sql --json 'SELECT count(*) AS n FROM tasks'")).stdout,
    );
    const apiCount = (await i.api("GET", "/tasks")).json.length;
    const appCount = (await i.run(i.app.listTasks())).length;
    assertEquals([cliJson.rows[0][0], apiCount, appCount], [3, 3, 3]);
  }));
