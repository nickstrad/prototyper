// Shared harness for the R3 native suites: ONE ManagedRuntime per SQLite
// backend (node:sqlite, sqlite-wasm) for the whole suite. The fetch handler,
// the application service, the raw DatabaseService and a change recorder all
// come from that runtime, so every assertion about "the same state" is about
// the same service, not a copy. The fixed clock starts at CLOCK_START and
// advances one second per reading (it is never rewound: tests read relative
// to what they created, not to absolute times).
import { Effect, Exit, ManagedRuntime, PubSub, Scope } from "effect";
import type { ApiHandler } from "../../packages/api/router.ts";
import type {
  DatabaseChange,
  DatabaseService,
} from "../../packages/core/types.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import {
  TaskApplication,
  type TaskApplicationShape,
} from "../../prototypes/task-manager/application.ts";
import { createTaskApiHandler } from "../../prototypes/task-manager/api.ts";
import { type Backend, backendLayer } from "../sqlite/harness.ts";

export { BACKENDS, CLOCK_START } from "../sqlite/harness.ts";
export type { Backend };

type Call = (
  method: string,
  path: string,
  body?: unknown,
  // deno-lint-ignore no-explicit-any
) => Promise<{ status: number; headers: Headers; text: string; json: any }>;

export type ApiHarness = {
  readonly app: TaskApplicationShape;
  readonly db: DatabaseService;
  readonly runtime: ManagedRuntime.ManagedRuntime<
    TaskApplication | Database,
    unknown
  >;
  /** Change events seen since the last `drain()` (any source). */
  drain(): Promise<DatabaseChange[]>;
  /** Runs an application effect on the shared runtime. */
  runApp<A, E>(effect: Effect.Effect<A, E, never>): Promise<A>;
  /** Defect details the handler reported (never sent to clients). */
  readonly defects: unknown[];
  /** Calls the default handler (no /sql) in-process; JSON bodies are stringified. */
  call: Call;
  /** Same runtime, handler created with `{ sql: true }` (the explorer's). */
  callWithSql: Call;
};

const getBoth = Effect.gen(function* () {
  return { app: yield* TaskApplication, db: yield* Database };
});

/**
 * Builds the shared runtime for `backend` and runs `body` with it. Cases that
 * need a clean database call `h.app.reset()` first (the seed is three rows).
 */
export const withApi = async (
  backend: Backend,
  body: (h: ApiHarness) => Promise<void>,
): Promise<void> => {
  const runtime = ManagedRuntime.make(
    backendLayer(backend),
  ) as unknown as ApiHarness["runtime"];
  const defects: unknown[] = [];
  try {
    const { app, db } = await runtime.runPromise(getBoth);
    const onDefect = (cause: unknown) => defects.push(cause);
    const caller =
      (handler: ApiHandler): Call => async (method, path, payload) => {
        const response = await handler(
          new Request(`https://api.invalid${path}`, {
            method,
            ...(payload === undefined ? {} : {
              body: typeof payload === "string"
                ? payload
                : JSON.stringify(payload),
              headers: { "content-type": "application/json" },
            }),
          }),
        );
        const text = await response.text();
        let json: unknown;
        try {
          json = text === "" ? undefined : JSON.parse(text);
        } catch {
          json = undefined;
        }
        return {
          status: response.status,
          headers: response.headers,
          text,
          json,
        };
      };
    const call = caller(createTaskApiHandler(runtime, { onDefect }));
    const callWithSql = caller(
      createTaskApiHandler(runtime, { onDefect, sql: true }),
    );
    const scope = await Effect.runPromise(Scope.make());
    const subscription = await Effect.runPromise(
      Scope.provide(scope)(db.subscribe),
    );
    try {
      await body({
        app,
        db,
        runtime,
        defects,
        runApp: (effect) => runtime.runPromise(effect),
        drain: () =>
          Effect.runPromise(
            PubSub.takeUpTo(subscription, Number.MAX_SAFE_INTEGER),
          ),
        call,
        callWithSql,
      });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  } finally {
    await runtime.dispose();
  }
};
