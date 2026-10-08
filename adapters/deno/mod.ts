/** Native-only entry point. Import browser backends from packages/database instead. */
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  nativeSqliteBackend,
  type NativeSqliteOptions,
} from "../../packages/database/native-sqlite.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import { runDatabaseCommand } from "../../packages/terminal/commands.ts";
import { fail } from "../../packages/terminal/effect-command.ts";
import {
  TaskClock,
  taskManagerLayer,
} from "../../prototypes/task-manager/application.ts";
import {
  createTaskApiHandler,
  type TaskApiOptions,
} from "../../prototypes/task-manager/api.ts";
import {
  runTasks,
  type TaskCommandsRuntime,
} from "../../prototypes/task-manager/commands.ts";

export interface NativeHostOptions extends NativeSqliteOptions, TaskApiOptions {
  readonly clock?: Layer.Layer<TaskClock>;
}

/** One scoped D1 service, eagerly opened; both adapters close over this runtime. */
export async function createNativeHost(options: NativeHostOptions = {}) {
  const runtime: TaskCommandsRuntime = ManagedRuntime.make(
    taskManagerLayer({
      backend: nativeSqliteBackend(options),
      clock: options.clock,
    }).pipe(Layer.orDie),
  );
  try {
    const database = await runtime.runPromise(Effect.service(Database));
    const fetch = createTaskApiHandler(runtime, options);
    return {
      database,
      fetch,
      command(argv: readonly string[], stdin = "") {
        const [name, ...args] = argv;
        switch (name) {
          case "tasks":
            return runTasks(runtime, args);
          case "db":
            return runDatabaseCommand(
              runtime,
              Effect.service(Database),
              args,
              stdin,
            );
          default:
            return Promise.resolve(fail("usage: <tasks|db> <command>\n", 2));
        }
      },
      dispose: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export type NativeHost = Awaited<ReturnType<typeof createNativeHost>>;

/** Transport only: never opens another database. Shutdown before host.dispose(). */
export function serveNativeHost(
  host: NativeHost,
  options: Deno.ServeTcpOptions = {},
) {
  return Deno.serve(
    { hostname: "127.0.0.1", port: 5197, ...options },
    host.fetch,
  );
}
