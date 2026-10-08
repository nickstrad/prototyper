import { assertEquals, assertRejects } from "@std/assert";
import { Effect } from "effect";
import { createNativeHost } from "../../adapters/deno/mod.ts";
import { TaskClock } from "../../prototypes/task-manager/application.ts";
import { transcript } from "./scenario.ts";

Deno.test("R9 single shared instance: CLI, API, direct service and reset", async () => {
  let closes = 0;
  let disposes = 0;
  const host = await createNativeHost({
    onClose: () => closes++,
    onDispose: () => disposes++,
  });
  try {
    const command = await host.command(["tasks", "create", "--json", "shared"]);
    assertEquals(command.exitCode, 0);
    const task = JSON.parse(command.stdout);
    const response = await host.fetch(
      new Request(`http://local/tasks/${task.id}`),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), task);
    await host.fetch(
      new Request(`http://local/tasks/${task.id}/complete`, { method: "POST" }),
    );
    assertEquals(
      JSON.parse(
        (await host.command(["tasks", "get", String(task.id), "--json"]))
          .stdout,
      ).completed,
      true,
    );
    assertEquals(
      (await Effect.runPromise(
        host.database.execute("SELECT title FROM tasks WHERE id = 4"),
      )).rows,
      [["shared"]],
    );
    assertEquals(
      (await host.fetch(new Request("http://local/sql", { method: "POST" })))
        .status,
      404,
    );
    await host.command(["db", "reset"]);
    assertEquals(
      (await host.fetch(new Request("http://local/tasks/4"))).status,
      404,
    );
  } finally {
    await host.dispose();
  }
  // reset closes the original connection; disposal closes its replacement.
  assertEquals(closes, 2);
  assertEquals(disposes, 1);
  await assertRejects(() =>
    Effect.runPromise(host.database.execute("SELECT 1"))
  );
});

Deno.test("R9 mixed operation transcript is deterministic", async () => {
  const host = await createNativeHost({
    sql: true,
    clock: TaskClock.fixed("2026-01-01T00:00:00.000Z"),
  });
  try {
    const result = await transcript(host);
    assertEquals(result.length, 29);
  } finally {
    await host.dispose();
  }
});

Deno.test("R9 native entry imports without browser globals or opening resources", async () => {
  const mod = await import("../../adapters/deno/main.ts");
  assertEquals(typeof mod.main, "function");
});
