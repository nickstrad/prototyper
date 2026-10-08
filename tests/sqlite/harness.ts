// Shared harness for the R1 native suites: the task manager on each in-process
// SQLite backend D1 provides (node:sqlite memory, @sqlite.org/sqlite-wasm
// memory), with a fixed clock, a fresh database per test and every change
// event recorded from the moment the runtime is built. Events are read from a
// PubSub subscription taken before the test body runs and drained without
// suspending, so no sleep decides what was published.
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope } from "effect";
import type { DatabaseChange } from "../../packages/core/types.ts";
import { nativeSqliteBackend } from "../../packages/database/native-sqlite.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import { sqliteWasmMemoryBackend } from "../../packages/database/sqlite-wasm.ts";
import {
  TaskApplication,
  type TaskApplicationShape,
  TaskClock,
  taskManagerLayer,
} from "../../prototypes/task-manager/application.ts";
import type { DatabaseService } from "../../packages/core/types.ts";

/** The fixed clock starts here and advances one second per reading. */
export const CLOCK_START = "2026-02-01T12:00:00.000Z";

export type Backend = "node:sqlite memory" | "sqlite-wasm memory";
export const BACKENDS: readonly Backend[] = [
  "node:sqlite memory",
  "sqlite-wasm memory",
];

export const backendLayer = (backend: Backend) =>
  taskManagerLayer({
    backend: backend === "node:sqlite memory"
      ? nativeSqliteBackend()
      : sqliteWasmMemoryBackend(),
    clock: TaskClock.fixed(CLOCK_START, 1000),
  });

export type Harness = {
  readonly app: TaskApplicationShape;
  readonly db: DatabaseService;
  /** Change events seen so far (app, shell and host writes). */
  readonly events: DatabaseChange[];
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
  /** Moves every change published so far into `events` (never waits). */
  settle(): Promise<void>;
  /** Yields to the event loop briefly (for fibers the test waits on). */
  tick(): Promise<void>;
};

const getBoth = Effect.gen(function* () {
  return { app: yield* TaskApplication, db: yield* Database };
});

export const withApp = async (
  backend: Backend,
  body: (h: Harness) => Promise<void>,
): Promise<void> => {
  const runtime = ManagedRuntime.make(
    backendLayer(backend).pipe(Layer.orDie),
  );
  try {
    const { app, db } = await runtime.runPromise(getBoth);
    const events: DatabaseChange[] = [];
    const scope = await Effect.runPromise(Scope.make());
    const subscription = await Effect.runPromise(
      Scope.provide(scope)(db.subscribe),
    );
    const settle = async () => {
      events.push(
        ...await Effect.runPromise(
          PubSub.takeUpTo(subscription, Number.MAX_SAFE_INTEGER),
        ),
      );
    };
    try {
      await body({
        app,
        db,
        events,
        run: (effect) => Effect.runPromise(effect),
        settle,
        tick: () => new Promise<void>((r) => setTimeout(r, 5)),
      });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  } finally {
    await runtime.dispose();
  }
};

/** Runs `effect` and returns its failure (throws if it succeeded). */
export const failure = async <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<E> => {
  const r = await Effect.runPromise(Effect.result(effect));
  if (r._tag === "Success") {
    throw new Error(`expected a failure, got ${JSON.stringify(r.success)}`);
  }
  return r.failure;
};
