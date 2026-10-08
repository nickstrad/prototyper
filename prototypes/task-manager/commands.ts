// Task manager CLI adapter (project.md §5, §11): `tasks ...` as a just-bash
// custom command over R1's TaskApplication, plus the standard `db` commands.
// Both run on the terminal's own ManagedRuntime (replaced after a failed
// build), whose layer resolves the same DatabaseService as the React UI: the
// service is what is shared, not a runtime. Every write goes through that
// service and is published on its `changes` stream; the UI re-renders from
// the stream, never from this adapter. Expected failures (InvalidInput, TaskNotFound,
// CorruptTask, DatabaseError) map to stderr + exit 1, usage errors to exit 2;
// defects are not caught here. Portable: no DOM, React or Deno APIs.
import { Cause, Effect, Layer, ManagedRuntime } from "effect";
import type { CustomCommand } from "just-bash";
import {
  command,
  type CommandResult,
  fail,
  runEffectCommand,
} from "../../packages/terminal/effect-command.ts";
import {
  databaseCommand,
  mergeCommands,
  runDatabaseCommand,
  takeJsonFlag,
} from "../../packages/terminal/commands.ts";
import {
  Database,
  DatabaseError as SqliteDatabaseError,
} from "../../packages/database/sqlite-service.ts";
import {
  describeTaskError,
  InvalidInput,
  type Task,
  TaskApplication,
  type TaskApplicationShape,
  type TaskError,
} from "./application.ts";

/** Re-exported so a host can swap these into its command list (one import). */
export { mergeCommands };

export const TASKS_USAGE = "usage: tasks <command>\n" +
  "  tasks list [--json]                     all tasks, ordered by id\n" +
  "  tasks get ID [--json]                   one task\n" +
  "  tasks create [--json] TITLE...          new task (words joined by spaces)\n" +
  "  tasks complete ID [--json]              mark done\n" +
  "  tasks update ID [--title TITLE] [--completed true|false] [--json]\n" +
  "  tasks delete ID [--json]                remove (prints the deleted task)\n";

/** The services the task terminal needs from the prototype's runtime. */
export type TaskCommandsRuntime = ManagedRuntime.ManagedRuntime<
  TaskApplication | Database,
  never
>;

/**
 * CLI text for an expected failure: R1's describeTaskError() (the same
 * message the UI shows) in lower-case CLI style, prefixed with the command.
 */
export const formatTaskError = (e: TaskError): string => {
  const text = describeTaskError(e);
  return `tasks: ${text.charAt(0).toLowerCase()}${text.slice(1)}\n`;
};

/** `4\t[x] Title` — the R0 example's list format. */
export const taskLine = (t: Task): string =>
  `${t.id}\t[${t.completed ? "x" : " "}] ${t.title}\n`;

const json = (value: unknown) => JSON.stringify(value) + "\n";

/**
 * argv → id for the application: a decimal integer string becomes a number
 * (the app checks the sign); beyond ±(2^53-1) the number would be rounded, so
 * either sign is "too large" here; anything else is InvalidInput, so "abc",
 * "1e3" or "" never turn into NaN, 1000 or 0 by accident.
 */
const parseId = (arg: string): Effect.Effect<number, InvalidInput> => {
  if (!/^[+-]?\d+$/.test(arg)) {
    return Effect.fail(
      new InvalidInput({
        message: `id must be an integer, got ${JSON.stringify(arg)}`,
      }),
    );
  }
  const id = Number(arg);
  return Number.isSafeInteger(id)
    ? Effect.succeed(id)
    : Effect.fail(new InvalidInput({ message: "id is too large" }));
};

const parseCompleted = (
  arg: string | undefined,
): Effect.Effect<boolean, InvalidInput> =>
  arg === "true" || arg === "false"
    ? Effect.succeed(arg === "true")
    : Effect.fail(
      new InvalidInput({
        message: `--completed expects true or false, got ${
          arg === undefined ? "nothing" : JSON.stringify(arg)
        }`,
      }),
    );

/** `--title T` / `--completed B` pairs into an R1 patch object. */
const parsePatch = (
  args: readonly string[],
): Effect.Effect<Record<string, unknown>, InvalidInput> =>
  Effect.gen(function* () {
    const patch: Record<string, unknown> = {};
    for (let i = 0; i < args.length; i += 2) {
      const [flag, value] = [args[i], args[i + 1]];
      if (flag === "--title" && value !== undefined) patch.title = value;
      else if (flag === "--completed") {
        patch.completed = yield* parseCompleted(value);
      } else {
        return yield* new InvalidInput({
          message: `unexpected argument ${JSON.stringify(flag)}` +
            " (expected --title TITLE or --completed true|false)",
        });
      }
    }
    return patch;
  });

type Program = Effect.Effect<string, TaskError, TaskApplication>;

/** A by-id subcommand: exactly one ID argument, else a usage error. */
const byId = (
  rest: readonly string[],
  run: (
    app: TaskApplicationShape,
    id: number,
  ) => Effect.Effect<string, TaskError>,
): Program | undefined =>
  rest.length === 1
    ? Effect.gen(function* () {
      const id = yield* parseId(rest[0]);
      const app = yield* TaskApplication;
      return yield* run(app, id);
    })
    : undefined;

const program = (args: readonly string[]): Program | undefined => {
  const [sub, ...raw] = args;
  const { json: asJson, rest } = takeJsonFlag(raw);
  const show = (verb: string) => (t: Task) =>
    asJson ? json(t) : `${verb} ${t.id}: ${t.title}\n`;
  switch (sub) {
    case "list":
      if (rest.length > 0) return undefined;
      return Effect.flatMap(TaskApplication, (app) => app.listTasks()).pipe(
        Effect.map((ts) => asJson ? json(ts) : ts.map(taskLine).join("")),
      );
    case "get":
      return byId(
        rest,
        (app, id) =>
          Effect.map(app.getTask(id), (t) => asJson ? json(t) : taskLine(t)),
      );
    case "create":
      if (rest.length === 0) return undefined;
      return Effect.flatMap(
        TaskApplication,
        (app) => app.createTask(rest.join(" ")),
      ).pipe(Effect.map(show("created")));
    case "complete":
      return byId(
        rest,
        (app, id) => Effect.map(app.completeTask(id), show("completed")),
      );
    case "delete":
      return byId(
        rest,
        (app, id) => Effect.map(app.deleteTask(id), show("deleted")),
      );
    case "update":
      if (rest.length < 3) return undefined;
      return Effect.gen(function* () {
        const id = yield* parseId(rest[0]);
        const patch = yield* parsePatch(rest.slice(1));
        const app = yield* TaskApplication;
        return show("updated")(yield* app.updateTask(id, patch));
      });
    default:
      return undefined;
  }
};

/** Runs one `tasks` invocation on `runtime` (exported for tests). */
export const runTasks = (
  runtime: ManagedRuntime.ManagedRuntime<TaskApplication, never>,
  args: readonly string[],
): Promise<CommandResult> => {
  const p = program(args);
  if (!p) return Promise.resolve(fail(TASKS_USAGE, 2));
  return runEffectCommand(runtime, p, formatTaskError);
};

/** `tasks ...` on the application in `runtime`. */
export const tasksCommand = (
  runtime: ManagedRuntime.ManagedRuntime<TaskApplication, never>,
): CustomCommand => command("tasks", (args) => runTasks(runtime, args));

/**
 * The task manager's terminal commands: `tasks` and the standard `db`
 * commands, on the same runtime (so the same DatabaseService) as the app.
 */
export const taskManagerCommands = (
  runtime: TaskCommandsRuntime,
): CustomCommand[] => [
  tasksCommand(runtime),
  databaseCommand(runtime, Effect.service(Database)),
];

/** Text for a runtime build failure, in the same style as other failures. */
const buildFailure = (name: string, cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  const tag = (error as { _tag?: unknown } | null)?._tag;
  if (
    tag === "DatabaseError" || tag === "InvalidInput" ||
    tag === "TaskNotFound" || tag === "CorruptTask"
  ) {
    const text = describeTaskError(error as TaskError);
    return `${name}: ${text.charAt(0).toLowerCase()}${text.slice(1)}\n`;
  }
  return `${name}: ${error instanceof Error ? error.message : String(error)}\n`;
};

/** One runtime and, once its layer build has failed, why. */
interface Generation {
  readonly runtime: TaskCommandsRuntime;
  buildFailure?: Cause.Cause<unknown>;
}

/**
 * `tasks` and `db` on a runtime over `layer` (e.g. the playground's
 * `playgroundTaskManagerLayer`, the very layer the R1 panel is built from, so
 * both resolve the page's one shared DatabaseService and no engine is started
 * here). The runtime is built lazily by the first command that needs it.
 *
 * Lifecycle:
 * - ManagedRuntime caches a failed build, so a layer build failure (e.g. no
 *   shared service appeared in time) is reported as that command's stderr +
 *   exit 1, the failed runtime is disposed and a new one replaces it: the
 *   next command builds (looks up) again. Concurrent commands on the same
 *   failed build all report the build error; only one rebuilds.
 * - A defect inside a command on a healthy runtime is rethrown (just-bash
 *   prints it, exit 1) and the runtime is kept.
 * - `dispose()` sticks: it disposes the current runtime, and every later
 *   command, or one in flight, fails with "terminal disposed" (exit 1)
 *   without building anything.
 *
 * `makeRuntime` is a test seam (default ManagedRuntime.make).
 */
export const taskManagerTerminal = <E>(
  layer: () => Layer.Layer<TaskApplication | Database, E>,
  options: {
    readonly makeRuntime?: (
      layer: Layer.Layer<TaskApplication | Database>,
    ) => TaskCommandsRuntime;
  } = {},
): {
  readonly commands: CustomCommand[];
  dispose(): Promise<void>;
} => {
  const makeRuntime = options.makeRuntime ?? ManagedRuntime.make;
  const make = (): Generation => {
    const gen: {
      runtime?: TaskCommandsRuntime;
      buildFailure?: Cause.Cause<unknown>;
    } = {};
    gen.runtime = makeRuntime(
      Layer.orDie(
        layer().pipe(
          Layer.tapCause((cause) =>
            Effect.sync(() => {
              if (!Cause.hasInterruptsOnly(cause)) gen.buildFailure = cause;
            })
          ),
        ),
      ),
    );
    return gen as Generation;
  };
  let disposed = false;
  let current = make();
  const disposedResult = (name: string) =>
    fail(
      buildFailure(
        name,
        Cause.fail(
          new SqliteDatabaseError({
            operation: "open",
            message: "terminal disposed",
            cause: null,
          }),
        ),
      ),
    );
  const withRuntime = async (
    name: string,
    run: (rt: TaskCommandsRuntime) => Promise<CommandResult>,
  ): Promise<CommandResult> => {
    if (disposed) return disposedResult(name);
    const gen = current;
    try {
      return await run(gen.runtime);
    } catch (defect) {
      if (disposed) return disposedResult(name);
      // Not a build failure: a real defect on a healthy runtime.
      if (gen.buildFailure === undefined) throw defect;
      if (current === gen) {
        current = make();
        await gen.runtime.dispose();
      }
      return fail(buildFailure(name, gen.buildFailure));
    }
  };
  return {
    commands: [
      command(
        "tasks",
        (args) => withRuntime("tasks", (rt) => runTasks(rt, args)),
      ),
      command(
        "db",
        (args, stdin) =>
          withRuntime(
            "db",
            (rt) =>
              runDatabaseCommand(rt, Effect.service(Database), args, stdin),
          ),
      ),
    ],
    dispose: () => {
      disposed = true;
      return current.runtime.dispose();
    },
  };
};
