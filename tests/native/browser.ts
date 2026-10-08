import { Effect, Layer, ManagedRuntime } from "effect";
import { browserSqliteBackend } from "../../packages/database/sqlite-browser.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import { runDatabaseCommand } from "../../packages/terminal/commands.ts";
import {
  TaskClock,
  taskManagerLayer,
} from "../../prototypes/task-manager/application.ts";
import { createTaskApiHandler } from "../../prototypes/task-manager/api.ts";
import { runTasks } from "../../prototypes/task-manager/commands.ts";
import { sqlFailures, transcript } from "./scenario.ts";

export async function browserTranscript() {
  const runtime = ManagedRuntime.make(
    taskManagerLayer({
      backend: browserSqliteBackend({ persistence: "memory", fresh: true }),
      clock: TaskClock.fixed("2026-01-01T00:00:00.000Z"),
    }).pipe(Layer.orDie),
  );
  try {
    const host = {
      fetch: createTaskApiHandler(runtime, { sql: true }),
      command: ([name, ...args]: readonly string[], stdin = "") =>
        name === "tasks"
          ? runTasks(runtime, args)
          : runDatabaseCommand(runtime, Effect.service(Database), args, stdin),
    };
    return {
      operations: await transcript(host),
      failures: await sqlFailures(host),
    };
  } finally {
    await runtime.dispose();
  }
}

Object.assign(globalThis, { r9Transcript: browserTranscript });
