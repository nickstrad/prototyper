import { Effect, Layer, ManagedRuntime, Scope } from "effect";
import { browserSqliteLayer } from "../../packages/database/sqlite-browser.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import { spawnEngineWorker } from "../../packages/database/worker-client.ts";
import {
  makeSqliteShellBinding,
  openScope,
} from "../../packages/database-editor/sqlite-shell.ts";
import { createApi } from "./api.ts";
import { schema, seed } from "./schema.ts";

export async function createHost() {
  const client = spawnEngineWorker({ name: "r11-bookmarks" });
  const runtime = ManagedRuntime.make(
    browserSqliteLayer({ client, schema, seed, persistence: "memory" }).pipe(
      Layer.orDie,
    ),
  );
  const { scope, close } = openScope();
  const dispose = async () => {
    try {
      await close();
    } finally {
      try {
        await runtime.dispose();
      } finally {
        client.terminate();
      }
    }
  };
  try {
    const service = await runtime.runPromise(Database);
    const info = await client.ready;
    const binding = await Effect.runPromise(
      Scope.provide(scope)(
        makeSqliteShellBinding({
          client,
          info,
          service,
          terminal: { cols: 70, rows: 12 },
        }),
      ),
    );
    return { handler: createApi(runtime), binding, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
export type Host = Awaited<ReturnType<typeof createHost>>;
