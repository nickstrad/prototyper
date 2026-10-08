// Shared harness for the R2 native suites: the task manager's terminal
// commands (`tasks`, `db`) in a just-bash shell, on one ManagedRuntime per
// test over each in-process SQLite backend D1 provides (R1's backendLayer:
// node:sqlite memory and sqlite-wasm memory, fixed clock). The test reads the
// app and DatabaseService from the SAME runtime the commands use, and every
// change event is recorded from a subscription taken before the body runs.
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope } from "effect";
import type { Bash } from "just-bash";
import type {
  DatabaseChange,
  DatabaseService,
} from "../../packages/core/types.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import { createShell } from "../../packages/terminal/shell.ts";
import {
  TaskApplication,
  type TaskApplicationShape,
} from "../../prototypes/task-manager/application.ts";
import {
  type TaskCommandsRuntime,
  taskManagerCommands,
} from "../../prototypes/task-manager/commands.ts";
import { type Backend, backendLayer } from "../sqlite/harness.ts";

export { type Backend, BACKENDS, CLOCK_START } from "../sqlite/harness.ts";

export type CliHarness = {
  readonly shell: Bash;
  readonly runtime: TaskCommandsRuntime;
  readonly app: TaskApplicationShape;
  readonly db: DatabaseService;
  /** Change events seen so far; call settle() first. */
  readonly events: DatabaseChange[];
  /** Runs one command line; returns stdout, stderr and the exit code. */
  sh(
    line: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
  /** Moves every change published so far into `events` (never waits). */
  settle(): Promise<void>;
};

export const withCli = async (
  backend: Backend,
  body: (h: CliHarness) => Promise<void>,
): Promise<void> => {
  const runtime: TaskCommandsRuntime = ManagedRuntime.make(
    backendLayer(backend).pipe(Layer.orDie),
  );
  try {
    const { app, db } = await runtime.runPromise(
      Effect.all({
        app: Effect.service(TaskApplication),
        db: Effect.service(Database),
      }),
    );
    const scope = await Effect.runPromise(Scope.make());
    const subscription = await Effect.runPromise(
      Scope.provide(scope)(db.subscribe),
    );
    const events: DatabaseChange[] = [];
    const shell = createShell(taskManagerCommands(runtime));
    try {
      await body({
        shell,
        runtime,
        app,
        db,
        events,
        sh: async (line) => {
          const r = await shell.exec(line);
          return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
        },
        run: (effect) => Effect.runPromise(effect),
        settle: async () => {
          events.push(
            ...await Effect.runPromise(
              PubSub.takeUpTo(subscription, Number.MAX_SAFE_INTEGER),
            ),
          );
        },
      });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  } finally {
    await runtime.dispose();
  }
};
