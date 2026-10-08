// CLI adapter for the example core: argv is already split by just-bash (so
// quoted arguments arrive intact), the program runs on the shared runtime, and
// typed failures map to stderr + exit 1.
import { Effect } from "effect";
import type { CustomCommand } from "just-bash";
import {
  command,
  type CommandResult,
  fail,
  ok,
  runEffectCommand,
} from "../effect-command.ts";
import {
  type AppClock,
  completeTask,
  createTask,
  InvalidInput,
  listTasks,
  type Task,
  type TaskError,
  type TasksRuntime,
  type TaskStore,
} from "./tasks.ts";

export const USAGE = "usage: tasks <create TITLE|list [--json]|complete ID>\n";

const formatError = (e: TaskError): string => {
  switch (e._tag) {
    case "InvalidInput":
      return `tasks: invalid input: ${e.message}\n`;
    case "TaskNotFound":
      return `tasks: task ${e.id} not found\n`;
  }
};

const line = (t: Task) => `${t.id}\t[${t.completed ? "x" : " "}] ${t.title}\n`;

const program = (
  args: readonly string[],
): Effect.Effect<string, TaskError, AppClock | TaskStore> | undefined => {
  const [sub, ...rest] = args;
  switch (sub) {
    case "create":
      return createTask(rest.join(" ")).pipe(
        Effect.map((t) => `created ${t.id}: ${t.title}\n`),
      );
    case "list":
      return listTasks.pipe(
        Effect.map((ts) =>
          rest.includes("--json")
            ? JSON.stringify(ts) + "\n"
            : ts.map(line).join("")
        ),
      );
    case "complete": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) {
        return Effect.fail(
          new InvalidInput({ message: "id must be an integer" }),
        );
      }
      return completeTask(id).pipe(Effect.map((t) => `completed ${t.id}\n`));
    }
    default:
      return undefined;
  }
};

export const runTasks = (
  runtime: TasksRuntime,
  args: readonly string[],
): Promise<CommandResult> => {
  const p = program(args);
  if (!p) return Promise.resolve(fail(USAGE, 2));
  return runEffectCommand(runtime, p, formatError);
};

/** `hello [NAME]` and `tasks ...`, the R0 example commands. */
export const exampleCommands = (runtime: TasksRuntime): CustomCommand[] => [
  command(
    "hello",
    (args) => Promise.resolve(ok(`Hello, ${args[0] ?? "world"}!\n`)),
  ),
  command("tasks", (args) => runTasks(runtime, args)),
];
