import { assertEquals } from "@std/assert";
import { Effect, Exit } from "effect";
import {
  AppClock,
  AppLayer,
  completeTask,
  createTask,
  listTasks,
} from "../src/core/tasks.ts";

const FIXED = "2026-01-02T03:04:05.000Z";
const run = <A, E>(
  eff: Effect.Effect<A, E, AppClock | import("../src/core/tasks.ts").TaskStore>,
) =>
  Effect.runPromiseExit(
    eff.pipe(Effect.provide(AppLayer(AppClock.fixed(FIXED)))),
  );

Deno.test("createTask uses the injected clock", async () => {
  const exit = await run(createTask("Build API"));
  assertEquals(Exit.isSuccess(exit) && exit.value.createdAt, FIXED);
});

Deno.test("empty title fails with typed InvalidInput", async () => {
  const exit = await run(createTask("   "));
  assertEquals(Exit.isFailure(exit), true);
  const err = await Effect.runPromise(
    Effect.flip(createTask("").pipe(Effect.provide(AppLayer()))),
  );
  assertEquals(err._tag, "InvalidInput");
});

Deno.test("completeTask of a missing id fails with TaskNotFound", async () => {
  const err = await Effect.runPromise(
    Effect.flip(completeTask(9).pipe(Effect.provide(AppLayer()))),
  );
  assertEquals(err._tag, "TaskNotFound");
  assertEquals(err.id, 9);
});

Deno.test("list reflects create + complete", async () => {
  const exit = await run(Effect.gen(function* () {
    yield* createTask("a");
    yield* completeTask(1);
    return yield* listTasks;
  }));
  assertEquals(Exit.isSuccess(exit) && exit.value.map((t) => t.completed), [
    true,
  ]);
});
