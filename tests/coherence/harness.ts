// One prototype instance, every interface (R4): a single ManagedRuntime per
// test over R1's backend layer hosts the application (web UI's core), R2's
// just-bash commands (CLI), R3's fetch handler (API) and the raw
// DatabaseService (what the editor's console and host controls use). The
// change observer subscribes before the body runs, so every assertion about
// "exactly one notification" is exact.
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import type { Bash } from "just-bash";
import type { DatabaseService } from "../../packages/core/types.ts";
import {
  type ChangeObserver,
  observeChanges,
  type Snapshot,
  snapshot,
} from "../../packages/core/events.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import { createShell } from "../../packages/terminal/shell.ts";
import {
  TaskApplication,
  type TaskApplicationShape,
} from "../../prototypes/task-manager/application.ts";
import { createTaskApiHandler } from "../../prototypes/task-manager/api.ts";
import {
  type TaskCommandsRuntime,
  taskManagerCommands,
} from "../../prototypes/task-manager/commands.ts";
import type { ApiHandler } from "../../packages/api/router.ts";
import { type Backend, backendLayer } from "../sqlite/harness.ts";

export { type Backend, BACKENDS } from "../sqlite/harness.ts";

export type Shelled = { stdout: string; stderr: string; exitCode: number };

export type Instance = {
  readonly runtime: TaskCommandsRuntime;
  readonly app: TaskApplicationShape;
  readonly db: DatabaseService;
  readonly shell: Bash;
  readonly handler: ApiHandler;
  readonly observer: ChangeObserver;
  /** CLI: one command line through just-bash. */
  cli(line: string): Promise<Shelled>;
  /** API: one in-process request; `json` is the parsed body (or undefined). */
  api(
    method: string,
    path: string,
    body?: unknown,
    // deno-lint-ignore no-explicit-any
  ): Promise<{ status: number; json: any; text: string }>;
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
  /** Snapshot of every table through the service. */
  snap(): Promise<Snapshot>;
};

export const withInstance = async (
  backend: Backend,
  body: (i: Instance) => Promise<void>,
): Promise<void> => {
  const runtime: TaskCommandsRuntime = ManagedRuntime.make(
    backendLayer(backend).pipe(Layer.orDie),
  );
  const scope = Effect.runSync(Scope.make());
  try {
    const app = await runtime.runPromise(Effect.service(TaskApplication));
    const db = await runtime.runPromise(Effect.service(Database));
    const observer = await Effect.runPromise(
      Scope.provide(scope)(observeChanges(db)),
    );
    const shell = createShell(taskManagerCommands(runtime));
    const handler = createTaskApiHandler(runtime);
    const instance: Instance = {
      runtime,
      app,
      db,
      shell,
      handler,
      observer,
      cli: async (line) => {
        const r = await shell.exec(line);
        return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
      },
      api: async (method, path, body) => {
        const response = await handler(
          new Request(`https://api.invalid${path}`, {
            method,
            headers: body === undefined
              ? {}
              : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
        const text = await response.text();
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        return { status: response.status, json, text };
      },
      run: (effect) => Effect.runPromise(effect),
      snap: () => Effect.runPromise(snapshot(db)),
    };
    await body(instance);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  }
};

/** Runs `body` once per SQLite backend as sequential Deno test steps. */
export const forEachBackend = async (
  t: Deno.TestContext,
  backends: readonly Backend[],
  body: (i: Instance, backend: Backend) => Promise<void>,
): Promise<void> => {
  for (const backend of backends) {
    await t.step(backend, () => withInstance(backend, (i) => body(i, backend)));
  }
};
