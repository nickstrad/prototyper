import { Effect, Exit, ManagedRuntime, Scope } from "effect";
import { browserSqliteBackend } from "../../packages/database/sqlite-browser.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import { spawnEngineWorker } from "../../packages/database/worker-client.ts";
import { makeSqliteShellBinding } from "../../packages/database-editor/sqlite-shell.ts";
import {
  taskManagerLayer,
  taskManagerLayerFromService,
} from "../../prototypes/task-manager/application.ts";

/** One owner, one worker, one service; every view borrows this service. */
export async function openCombinedSession() {
  const client = spawnEngineWorker({ name: "combined-task-manager" });
  const runtime = ManagedRuntime.make(taskManagerLayer({
    backend: browserSqliteBackend({ client, persistence: "memory" }),
  }));
  const scope = Effect.runSync(Scope.make());
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    } finally {
      client.terminate();
    }
  };
  try {
    const service = await runtime.runPromise(Effect.service(Database));
    const binding = await Effect.runPromise(
      Scope.provide(scope)(
        makeSqliteShellBinding({
          client,
          info: await client.ready,
          service,
          terminal: { cols: 80, rows: 14 },
        }),
      ),
    );
    const layer = () => taskManagerLayerFromService(service);
    return { service, binding, layer, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export type CombinedSession = Awaited<ReturnType<typeof openCombinedSession>>;
