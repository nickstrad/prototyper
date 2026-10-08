// CLI adapter: parses argv (already split by just-bash), runs core Effects
// through the shared runtime and maps typed failures to stderr + exit 1.
import { Effect } from "effect";
import { type CustomCommand, defineCommand } from "just-bash";
import type { AppRuntime } from "../core/runtime.ts";
import {
  type AppClock,
  completeTask,
  createTask,
  InvalidInput,
  listTasks,
  type Task,
  type TaskError,
  type TaskStore,
} from "../core/tasks.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const ok = (stdout: string): CommandResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
});

const formatError = (e: TaskError): string => {
  switch (e._tag) {
    case "InvalidInput":
      return `tasks: invalid input: ${e.message}\n`;
    case "TaskNotFound":
      return `tasks: task ${e.id} not found\n`;
  }
};

const line = (t: Task) => `${t.id}\t[${t.completed ? "x" : " "}] ${t.title}\n`;

export const runTasks = (
  runtime: AppRuntime,
  args: readonly string[],
): Promise<CommandResult> => {
  const [sub, ...rest] = args;
  const program:
    | Effect.Effect<string, TaskError, AppClock | TaskStore>
    | undefined = (() => {
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
          return completeTask(id).pipe(
            Effect.map((t) => `completed ${t.id}\n`),
          );
        }
        default:
          return undefined;
      }
    })();
  if (!program) {
    return Promise.resolve({
      stdout: "",
      stderr: "usage: tasks <create TITLE|list [--json]|complete ID>\n",
      exitCode: 2,
    });
  }
  return runtime.runPromise(
    program.pipe(
      Effect.map(ok),
      Effect.catch((e) =>
        Effect.succeed({ stdout: "", stderr: formatError(e), exitCode: 1 })
      ),
    ),
  );
};

export const appCommands = (runtime: AppRuntime): CustomCommand[] => [
  defineCommand(
    "hello",
    (args) => Promise.resolve(ok(`Hello, ${args[0] ?? "world"}!\n`)),
  ),
  defineCommand("tasks", (args) => runTasks(runtime, args)),
];
