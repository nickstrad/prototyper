// Task manager fetch API (project.md §5, §11): the task application behind
// routes, called with a standard Request and answering a standard Response
// (packages/api/router.ts). No network transport: tests and the playground
// explorer call the handler in-process. It runs on the runtime its caller
// supplies; across interfaces today only the DatabaseService (and so the
// change stream) is shared, each interface builds its own runtime over it.
//
//   GET    /tasks                 200 [task]
//   GET    /tasks/:id             200 task
//   POST   /tasks                 201 task      body {"title": "..."}
//   PATCH  /tasks/:id             200 task      body {"title"?, "completed"?}
//   DELETE /tasks/:id             200 task      the task as it was
//   POST   /tasks/:id/complete    200 task
//   POST   /reset                 200 {"reset": true}
//   POST   /sql                   200 result    OPT-IN: createTaskApiHandler(
//                                               runtime, {sql: true}); absent
//                                               (404) by default
//                                 body {"sql": "<one statement>", "maxRows"?}
//
// Failures: InvalidInput -> 400, TaskNotFound -> 404, CorruptTask and
// DatabaseError -> 500, each as {"error": {"code", "message"}}; defects are a
// fixed 500 InternalError (packages/api). Cells in /sql results go through
// encodeCell (bigint and blob are tagged objects).
//
// /sql runs arbitrary SQL on the shared database (it can DROP the tasks
// table): it exists for the playground explorer only and must never be
// enabled on a handler reachable by untrusted callers. It accepts a single
// statement (detected by a conservative scanner, so a script, or a
// CREATE TRIGGER body with inner semicolons, is refused with 400 before
// anything runs, and a rejected statement cannot have committed part of a
// script), reports changes with source "host" (R2's `db sql` uses "shell"),
// and answers every engine rejection as 400 SqlError, including engine
// faults that /tasks would report as 500.
import { Effect, type ManagedRuntime } from "effect";
import type { Cause } from "effect";
import {
  type ApiFailure,
  type ApiHandler,
  created,
  encodeQueryResult,
  failure,
  makeApiHandler,
  ok,
  type Route,
  route,
} from "../../packages/api/router.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import {
  describeTaskError,
  InvalidInput,
  TaskApplication,
  type TaskError,
} from "./application.ts";

/** What the routes need from the runtime. */
export type TaskApiServices = TaskApplication | Database;

type TaskRoute = Route<TaskApiServices, TaskError>;

/** Status for each expected failure; defects never reach this. */
export const taskErrorToFailure = (error: TaskError): ApiFailure => {
  const message = describeTaskError(error);
  switch (error._tag) {
    case "InvalidInput":
      return failure(400, error._tag, message);
    case "TaskNotFound":
      return failure(404, error._tag, message);
    case "CorruptTask":
    case "DatabaseError":
      return failure(500, error._tag, message);
  }
};

/**
 * `/tasks/abc` or `/tasks/-1` reach the application as numbers it rejects
 * (the application owns the id rules); text that is not an integer becomes
 * NaN, so the answer is its "id must be an integer" InvalidInput.
 */
const idParam = (raw: string): number =>
  /^-?\d+$/.test(raw) ? Number(raw) : NaN;

/** A JSON object body, or InvalidInput. */
const objectBody = (body: unknown): Effect.Effect<
  Record<string, unknown>,
  InvalidInput
> =>
  typeof body === "object" && body !== null && !Array.isArray(body)
    ? Effect.succeed(body as Record<string, unknown>)
    : Effect.fail(
      new InvalidInput({ message: "body must be a JSON object" }),
    );

export const taskApiRoutes: readonly TaskRoute[] = [
  route("GET", "/tasks", () =>
    Effect.gen(function* () {
      return ok(yield* (yield* TaskApplication).listTasks());
    })),

  route("GET", "/tasks/:id", ({ params }) =>
    Effect.gen(function* () {
      return ok(yield* (yield* TaskApplication).getTask(idParam(params.id)));
    })),

  route("POST", "/tasks", ({ json }) =>
    Effect.gen(function* () {
      const body = yield* objectBody(yield* json);
      const task = yield* (yield* TaskApplication).createTask(body.title);
      return created(task, `/tasks/${task.id}`);
    })),

  route("PATCH", "/tasks/:id", ({ params, json }) =>
    Effect.gen(function* () {
      const body = yield* objectBody(yield* json);
      return ok(
        yield* (yield* TaskApplication).updateTask(idParam(params.id), body),
      );
    })),

  route("DELETE", "/tasks/:id", ({ params }) =>
    Effect.gen(function* () {
      return ok(yield* (yield* TaskApplication).deleteTask(idParam(params.id)));
    })),

  route("POST", "/tasks/:id/complete", ({ params }) =>
    Effect.gen(function* () {
      return ok(
        yield* (yield* TaskApplication).completeTask(idParam(params.id)),
      );
    })),

  route("POST", "/reset", () =>
    Effect.gen(function* () {
      yield* (yield* TaskApplication).reset();
      return ok({ reset: true });
    })),
];

/** SQLite's whitespace: only these five (not JS `\s`, which adds Unicode spaces and `\v`). */
const SQL_WHITESPACE = /[ \t\n\f\r]/;

/**
 * True when `sql` holds at most one statement: a `;` may only be followed by
 * whitespace and comments. String literals ('...'), quoted identifiers
 * ("...", `...`, [...]) and comments are skipped, so `;` inside them is fine.
 * Deliberately conservative: a CREATE TRIGGER body (inner `;`) is refused.
 */
export const isSingleStatement = (sql: string): boolean => {
  let sawSemicolon = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (SQL_WHITESPACE.test(c)) i++;
    else {
      if (sawSemicolon) return false;
      if (c === ";") sawSemicolon = true;
      else if (c === "'" || c === '"' || c === "`" || c === "[") {
        const close = c === "[" ? "]" : c;
        i++;
        // A doubled quote is an escaped quote; [..] has no escape.
        while (i < sql.length) {
          if (sql[i] === close) {
            if (close !== "]" && sql[i + 1] === close) i += 2;
            else break;
          } else i++;
        }
      }
      i++;
    }
  }
  return true;
};

/**
 * Opt-in inspection route (see the header): one SQL statement on the shared
 * database, cells via encodeCell. A statement the engine rejects is treated
 * as the caller's mistake (400), unlike the application's own DatabaseErrors.
 */
export const taskSqlRoute: TaskRoute = route(
  "POST",
  "/sql",
  ({ json }) =>
    Effect.gen(function* () {
      const body = yield* objectBody(yield* json);
      const { sql, maxRows } = body;
      if (typeof sql !== "string" || sql.trim() === "") {
        return yield* new InvalidInput({
          message: "sql is required (a non-empty string)",
        });
      }
      if (
        maxRows !== undefined &&
        !(Number.isInteger(maxRows) && (maxRows as number) > 0)
      ) {
        return yield* new InvalidInput({
          message: "maxRows must be a positive integer",
        });
      }
      if (!isSingleStatement(sql)) {
        return yield* new InvalidInput({
          message: "sql must be a single statement (one request, one " +
            "statement; a script could commit part of itself before failing)",
        });
      }
      const db = yield* Database;
      const result = yield* db.execute(sql, {
        source: "host",
        ...(maxRows === undefined ? {} : { maxRows: maxRows as number }),
      }).pipe(
        Effect.catchTag(
          "DatabaseError",
          (e) => Effect.fail(failure(400, "SqlError", e.message)),
        ),
      );
      return ok(encodeQueryResult(result));
    }),
);

export interface TaskApiOptions {
  readonly onDefect?: (cause: Cause.Cause<unknown>) => void;
  /** Registers POST /sql (arbitrary SQL; explorer and tests only). Default false. */
  readonly sql?: boolean;
}

/**
 * The task API as a fetch handler on the caller's runtime (the playground's
 * explorer runtime, a test's); disposing it is theirs. `/sql` is registered
 * only with `{ sql: true }`.
 */
export const createTaskApiHandler = (
  runtime: ManagedRuntime.ManagedRuntime<TaskApiServices, unknown>,
  options: TaskApiOptions = {},
): ApiHandler =>
  makeApiHandler({
    runtime,
    routes: options.sql === true
      ? [...taskApiRoutes, taskSqlRoute]
      : taskApiRoutes,
    mapError: taskErrorToFailure,
    onDefect: options.onDefect,
  });
