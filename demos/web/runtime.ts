import { Effect, Layer } from "effect";
import { engineWorkerScoped } from "../../packages/database/worker-client.ts";
import { browserSqliteLayer } from "../../packages/database/sqlite-browser.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import { makeSqliteShellBinding } from "../../packages/database-editor/sqlite-shell.ts";
import { schema, seed } from "./application.ts";

export const openNotes = Effect.gen(function* () {
  const client = yield* engineWorkerScoped({ name: "web-notes" });
  const info = yield* Effect.promise(() => client.ready);
  const context = yield* Layer.build(browserSqliteLayer({
    client,
    persistence: "memory",
    schema,
    seed,
  }));
  const service = yield* Database.pipe(Effect.provideContext(context));
  const binding = yield* makeSqliteShellBinding({
    client,
    info,
    service,
    terminal: { cols: 40, rows: 14 },
  });
  return { service, binding };
});
