import { Effect, Exit, Scope } from "effect";
import { createRoot } from "react-dom/client";
import {
  sqlitePersistence,
  SqlitePersistenceStatus,
} from "../../../packages/database/sqlite-persistence.tsx";
import {
  TASKS_SCHEMA,
  TASKS_SEED,
} from "../../../packages/database/sqlite-seed.ts";
import type { DatabaseService } from "../../../packages/core/types.ts";

export interface PersistenceHarness {
  readonly persistence: DatabaseService["persistence"];
  exec(sql: string): Promise<unknown>;
  reset(): Promise<void>;
  close(): Promise<void>;
}
declare global {
  var r7: PersistenceHarness | undefined;
}
const root = createRoot(document.getElementById("root")!);
const scope = Effect.runSync(Scope.make());
try {
  const service = await Effect.runPromise(
    sqlitePersistence({ schema: TASKS_SCHEMA, seed: TASKS_SEED }).pipe(
      Scope.provide(scope),
    ),
  );
  globalThis.r7 = {
    persistence: service.persistence,
    exec: (sql) => Effect.runPromise(service.execute(sql)),
    reset: () => Effect.runPromise(service.reset()),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
  root.render(
    <main>
      <h1>SQLite persistence</h1>
      <SqlitePersistenceStatus persistence={service.persistence} />
    </main>,
  );
} catch (error) {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  root.render(<p role="alert">{String(error)}</p>);
}
