// Task manager application core (project.md §5, §11): every domain operation
// as an Effect over D1's shared DatabaseService, independent of the interface
// that invokes it (React here; CLI and API adapters later). Input is decoded
// with Effect Schema (schema.ts); expected failures are tagged errors
// (InvalidInput, TaskNotFound, DatabaseError) and anything else is a defect.
// Portable: no DOM, Deno, React or worker imports, so it runs under Deno
// tests on node:sqlite / sqlite-wasm and in the browser on the Fiddle engine.
//
// D1 has no parameter binding yet (plan.md §9), so values reach SQL only
// after validation: ids are safe positive integers and titles are quoted
// with sqlString() and contain no control characters.
import {
  Context,
  Effect,
  Layer,
  PubSub,
  Schema,
  type Scope,
  type Stream,
} from "effect";
import type {
  DatabaseChange,
  DatabaseError,
  DatabaseService,
  QueryResult,
} from "../../packages/core/types.ts";
import {
  Database,
  DatabaseError as SqliteDatabaseError,
  layer as sqliteLayer,
  type SqliteBackend,
  sqlString,
} from "../../packages/database/sqlite-service.ts";
import {
  CorruptTask,
  InvalidInput,
  Task,
  TASK_COLUMNS,
  TaskId,
  TaskNotFound,
  TaskPatch,
  TaskRow,
  TASKS_TABLE_SQL,
  Title,
} from "./schema.ts";
import { TASKS_SEED_SQL } from "./seed.ts";

export { CorruptTask, InvalidInput, Task, TaskNotFound };
export type { DatabaseError };

/**
 * Expected failures. DatabaseError is the §9 shape from core/types.ts; at
 * runtime it is D1's tagged class, so `Effect.catchTag` works on all four.
 */
export type TaskError =
  | InvalidInput
  | TaskNotFound
  | CorruptTask
  | DatabaseError;

/** listTasks() fails rather than silently truncating past this many rows. */
export const LIST_LIMIT = 10_000;

/** Ids stay JavaScript-safe integers; createTask refuses to go beyond. */
export const MAX_TASK_ID = Number.MAX_SAFE_INTEGER;

type ById = InvalidInput | TaskNotFound | CorruptTask | DatabaseError;

/**
 * The application contract. Dependencies (database, clock) are supplied when
 * the service is built, so every operation has no requirements. Inputs are
 * `unknown` because adapters hand over raw values (argv, JSON bodies, form
 * fields); each one is decoded before use.
 *
 * Stored rows the app cannot read fail with CorruptTask naming their ids.
 * Mutations are guarded: they never write to such a row (nothing is
 * committed, no change event), so an operation either succeeds in both the
 * database and the app or writes nothing.
 */
export interface TaskApplicationShape {
  listTasks(): Effect.Effect<readonly Task[], CorruptTask | DatabaseError>;
  getTask(id: unknown): Effect.Effect<Task, ById>;
  createTask(title: unknown): Effect.Effect<Task, InvalidInput | DatabaseError>;
  /** PATCH: `{ title?, completed? }`, at least one key. */
  updateTask(id: unknown, patch: unknown): Effect.Effect<Task, ById>;
  completeTask(id: unknown): Effect.Effect<Task, ById>;
  /** Returns the task as it was before deletion. */
  deleteTask(id: unknown): Effect.Effect<Task, ById>;
  /** Back to the deterministic seed (D1 reset re-applies schema + seed). */
  reset(): Effect.Effect<void, DatabaseError>;
  /** Every change published by this DatabaseService (source app, shell or host). */
  readonly changes: Stream.Stream<DatabaseChange>;
  /** A subscription that exists before the caller's first read. */
  readonly subscribe: DatabaseService["subscribe"];
}

export class TaskApplication extends Context.Service<
  TaskApplication,
  TaskApplicationShape
>()("prototyper/task-manager/TaskApplication") {}

/** Injected clock for `created_at`, so tests are deterministic. */
export class TaskClock extends Context.Service<TaskClock, {
  readonly now: Effect.Effect<Date>;
}>()("prototyper/task-manager/TaskClock") {
  static readonly live: Layer.Layer<TaskClock> = Layer.succeed(this)({
    now: Effect.sync(() => new Date()),
  });
  /** Starts at `iso` and advances `stepMs` after every reading. */
  static fixed(iso: string, stepMs = 0): Layer.Layer<TaskClock> {
    return Layer.sync(this)(() => {
      let next = Date.parse(iso);
      return {
        now: Effect.sync(() => {
          const date = new Date(next);
          next += stepMs;
          return date;
        }),
      };
    });
  }
}

// ---- input and row decoding ------------------------------------------------

/**
 * One readable line from a schema issue, named after the offending field:
 * "title is required", "completed: Expected boolean", "row[2]: Expected 0 | 1".
 */
const issueText = (field: string, error: Schema.SchemaError): string => {
  const [first, ...rest] = error.message.split("\n");
  const key = rest.join(" ").match(/at \["?([^"\]]+)"?\]/)?.[1];
  const name = key === undefined
    ? field
    : /^\d+$/.test(key)
    ? `${field}[${key}]`
    : key;
  const text = first.trim();
  return text.startsWith(name) ? text : `${name}: ${text}`;
};

const decodeInput = <S extends Schema.Decoder<unknown>>(
  schema: S,
  field: string,
) =>
(input: unknown): Effect.Effect<S["Type"], InvalidInput> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((e) => new InvalidInput({ message: issueText(field, e) })),
  );

const decodeTitle = decodeInput(Title, "title");
const decodeId = decodeInput(TaskId, "id");
const decodePatch = decodeInput(TaskPatch, "patch");

/** A stored row the app cannot read: its rowid as text and the problem. */
type BadRow = { readonly id: string; readonly problem: string };

const decodeRow = (row: readonly unknown[]): Effect.Effect<Task, BadRow> =>
  Schema.decodeUnknownEffect(TaskRow)(row).pipe(
    Effect.map(([id, title, completed, createdAt]): Task => ({
      id,
      title,
      completed: completed === 1,
      createdAt,
    })),
    Effect.mapError((e) => ({
      id: String(row[0]),
      problem: issueText("row", e),
    })),
  );

/** How many bad rows CorruptTask's message details; `ids` lists them all. */
export const CORRUPT_DETAIL_LIMIT = 5;

const corrupt = (bad: readonly BadRow[]) => {
  const shown = bad.slice(0, CORRUPT_DETAIL_LIMIT);
  const more = bad.length - shown.length;
  return new CorruptTask({
    ids: bad.map((b) => b.id),
    message: shown.map((b) => `task ${b.id}: ${b.problem}`).join("; ") +
      (more > 0 ? `; and ${more} more` : ""),
  });
};

/**
 * Every row decoded; rows that fail (written outside the app, e.g. by SQL in
 * the editor) are all reported by id in one CorruptTask, so a single bad row
 * names itself instead of wedging the list anonymously.
 */
const decodeRows = (
  result: QueryResult,
): Effect.Effect<readonly Task[], CorruptTask> =>
  Effect.gen(function* () {
    const tasks: Task[] = [];
    const bad: BadRow[] = [];
    for (const row of result.rows) {
      const r = yield* Effect.result(decodeRow(row));
      if (r._tag === "Success") tasks.push(r.success);
      else bad.push(r.failure);
    }
    return bad.length > 0 ? yield* corrupt(bad) : tasks;
  });

/**
 * SQL restatement of TaskRow, used as a guard in every mutation's WHERE
 * clause: a mutation never touches (or commits on) a row the app cannot
 * read back, so it cannot succeed in the database and fail in the app.
 */
const READABLE_ROW = "id BETWEEN 1 AND 9007199254740991" +
  " AND typeof(title) = 'text'" +
  " AND typeof(completed) = 'integer' AND completed IN (0, 1)" +
  " AND typeof(created_at) = 'text'";

// ---- the service -----------------------------------------------------------

/** Builds the application on whatever Database and TaskClock are provided. */
export const make: Effect.Effect<
  TaskApplicationShape,
  never,
  Database | TaskClock
> = Effect.gen(function* () {
  const db = yield* Database;
  const clock = yield* TaskClock;

  const selectById = (id: number) =>
    db.execute(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ${id}`).pipe(
      Effect.flatMap(decodeRows),
    );

  /** The row a guarded statement returned; it passed READABLE_ROW. */
  const returned = (sql: string, row: readonly unknown[]) =>
    decodeRow(row).pipe(
      Effect.catch((bad) =>
        Effect.die(
          new Error(
            `READABLE_ROW and TaskRow disagree on task ${bad.id} (${bad.problem}) after: ${sql}`,
          ),
        )
      ),
    );

  /**
   * A guarded single-row mutation with RETURNING. No row back means nothing
   * was written; a follow-up read says why (absent, or unreadable).
   */
  const mutate = (
    id: number,
    sql: string,
  ): Effect.Effect<Task, TaskNotFound | CorruptTask | DatabaseError> =>
    Effect.gen(function* () {
      const r = yield* db.execute(sql);
      if (r.rows.length > 0) return yield* returned(sql, r.rows[0]);
      const rows = yield* selectById(id); // CorruptTask when unreadable
      if (rows.length === 0) return yield* new TaskNotFound({ id });
      // Readable now but not when the guard ran: a concurrent external
      // write in between. Nothing was written; the caller may retry.
      return yield* new SqliteDatabaseError({
        operation: "execute",
        message: `task ${id} changed concurrently; nothing written`,
        cause: null,
      });
    });

  const guarded = (id: number) =>
    `WHERE id = ${id} AND ${READABLE_ROW} RETURNING ${TASK_COLUMNS}`;

  const listTasks = (): Effect.Effect<
    readonly Task[],
    CorruptTask | DatabaseError
  > =>
    Effect.gen(function* () {
      const r = yield* db.execute(
        `SELECT ${TASK_COLUMNS} FROM tasks ORDER BY id`,
        { maxRows: LIST_LIMIT },
      );
      if (r.truncated) {
        return yield* new SqliteDatabaseError({
          operation: "execute",
          message:
            `more than ${LIST_LIMIT} tasks; listTasks refuses to truncate`,
          cause: null,
        });
      }
      return yield* decodeRows(r);
    });

  const getTask = (input: unknown) =>
    decodeId(input).pipe(
      Effect.flatMap((id) =>
        selectById(id).pipe(
          Effect.flatMap((rows) =>
            rows.length > 0
              ? Effect.succeed(rows[0])
              : Effect.fail(new TaskNotFound({ id }))
          ),
        )
      ),
    );

  const createTask = (input: unknown) =>
    Effect.gen(function* () {
      const title = yield* decodeTitle(input);
      const now = yield* clock.now;
      // The next rowid is max(id) + 1; refuse (writing nothing) when that
      // would leave the safe-integer range instead of storing a bigint id.
      const sql = `INSERT INTO tasks (title, completed, created_at) SELECT ${
        sqlString(title)
      }, 0, ${
        sqlString(now.toISOString())
      } WHERE (SELECT coalesce(max(id), 0) FROM tasks) < ${MAX_TASK_ID} RETURNING ${TASK_COLUMNS}`;
      const r = yield* db.execute(sql);
      if (r.rows.length === 0) {
        return yield* new SqliteDatabaseError({
          operation: "execute",
          message:
            `no task id left: the largest id is ${MAX_TASK_ID} (2^53-1); nothing written`,
          cause: null,
        });
      }
      return yield* returned(sql, r.rows[0]);
    });

  const updateTask = (idInput: unknown, patchInput: unknown) =>
    Effect.gen(function* () {
      const id = yield* decodeId(idInput);
      const patch = yield* decodePatch(patchInput);
      const sets: string[] = [];
      if (patch.title !== undefined) {
        sets.push(`title = ${sqlString(patch.title)}`);
      }
      if (patch.completed !== undefined) {
        sets.push(`completed = ${patch.completed ? 1 : 0}`);
      }
      if (sets.length === 0) {
        return yield* new InvalidInput({
          message: "patch: nothing to update (expected title or completed)",
        });
      }
      return yield* mutate(
        id,
        `UPDATE tasks SET ${sets.join(", ")} ${guarded(id)}`,
      );
    });

  const completeTask = (input: unknown) =>
    decodeId(input).pipe(
      Effect.flatMap((id) =>
        mutate(id, `UPDATE tasks SET completed = 1 ${guarded(id)}`)
      ),
    );

  const deleteTask = (input: unknown) =>
    decodeId(input).pipe(
      Effect.flatMap((id) => mutate(id, `DELETE FROM tasks ${guarded(id)}`)),
    );

  return {
    listTasks,
    getTask,
    createTask,
    updateTask,
    completeTask,
    deleteTask,
    reset: () => db.reset(),
    changes: db.changes,
    subscribe: db.subscribe,
  };
});

/** The application on a provided Database and TaskClock. */
export const layer: Layer.Layer<TaskApplication, never, Database | TaskClock> =
  Layer.effect(TaskApplication)(make);

/** D1 service options that give a database this application's schema + seed. */
export const taskDatabaseOptions = {
  schema: TASKS_TABLE_SQL,
  seed: TASKS_SEED_SQL,
} as const;

/**
 * The whole prototype on one SQLite backend (node:sqlite, sqlite-wasm or the
 * Fiddle engine worker): seeded Database + clock + application. Scoped: the
 * backend is released when the runtime built from it is disposed.
 */
export const taskManagerLayer = (options: {
  readonly backend: Effect.Effect<
    SqliteBackend,
    SqliteDatabaseError,
    Scope.Scope
  >;
  readonly clock?: Layer.Layer<TaskClock>;
}): Layer.Layer<TaskApplication | Database | TaskClock, DatabaseError> =>
  layer.pipe(
    Layer.provideMerge(
      Layer.merge(
        sqliteLayer({ ...taskDatabaseOptions, backend: options.backend }),
        options.clock ?? TaskClock.live,
      ),
    ),
  );

/**
 * The application on an already running DatabaseService owned by someone
 * else (e.g. the page's shared engine). The caller is responsible for that
 * database carrying the tasks table; its own seed applies on reset.
 */
export const taskManagerLayerFromService = (
  service: DatabaseService,
  clock: Layer.Layer<TaskClock> = TaskClock.live,
): Layer.Layer<TaskApplication | Database | TaskClock> =>
  layer.pipe(
    Layer.provideMerge(
      Layer.merge(Layer.succeed(Database)(service), clock),
    ),
  );

/**
 * The application on a DatabaseService that another part of the host
 * publishes asynchronously (the playground's workbench, until main injects
 * the page's single engine through the `layer` prop). Waits up to
 * `timeoutMs` for `lookup()` to return a service, then fails visibly with a
 * DatabaseError naming `what`; it never starts an engine of its own.
 */
export const taskManagerLayerFromLookup = (
  lookup: () => DatabaseService | undefined,
  options: {
    readonly what: string;
    readonly timeoutMs: number;
    readonly pollMs?: number;
    readonly clock?: Layer.Layer<TaskClock>;
  },
): Layer.Layer<TaskApplication | Database | TaskClock, DatabaseError> =>
  Layer.unwrap(
    Effect.callback<DatabaseService, DatabaseError>((resume) => {
      const deadline = Date.now() + options.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const look = () => {
        const service = lookup();
        if (service) resume(Effect.succeed(service));
        else if (Date.now() >= deadline) {
          resume(Effect.fail(
            new SqliteDatabaseError({
              operation: "open",
              message:
                `no shared database service on this page: ${options.what} ` +
                `did not appear within ${options.timeoutMs} ms`,
              cause: null,
            }),
          ));
        } else timer = setTimeout(look, options.pollMs ?? 50);
      };
      look();
      return Effect.sync(() => clearTimeout(timer));
    }).pipe(
      Effect.map((service) =>
        taskManagerLayerFromService(service, options.clock)
      ),
    ),
  );

// ---- reactive view ---------------------------------------------------------

/** What a view needs after each (re)load. */
export type TasksSnapshot = {
  readonly tasks: readonly Task[];
  /** Changes coalesced into this load; empty for the initial load. */
  readonly changes: readonly DatabaseChange[];
  /** 1 for the initial load, then +1 per reload. */
  readonly load: number;
};

/**
 * Loads the task list once, then reloads it after every change event on the
 * database, never on a timer. The subscription is taken before the first
 * read, so no write between the two is missed; events that queue up while a
 * reload runs are coalesced into the next one. Load failures are reported
 * and watching continues. Runs until interrupted.
 */
export const watchTasks = (
  onSnapshot: (snapshot: TasksSnapshot) => void,
  onError: (error: CorruptTask | DatabaseError) => void = () => {},
): Effect.Effect<never, never, TaskApplication> =>
  Effect.gen(function* () {
    const app = yield* TaskApplication;
    return yield* Effect.scoped(Effect.gen(function* () {
      const subscription = yield* app.subscribe;
      let load = 0;
      const reload = (changes: readonly DatabaseChange[]) =>
        app.listTasks().pipe(
          Effect.match({
            onSuccess: (tasks) => onSnapshot({ tasks, changes, load: ++load }),
            onFailure: onError,
          }),
        );
      yield* reload([]);
      return yield* Effect.forever(
        PubSub.takeAll(subscription).pipe(Effect.flatMap(reload)),
      );
    }));
  });

// ---- adapter boundary ------------------------------------------------------

/**
 * A message safe to show a person for an expected failure. Interfaces use it
 * for UI text and CLI stderr; HTTP maps InvalidInput → 400, TaskNotFound →
 * 404, CorruptTask and DatabaseError → 500. Defects never reach this function.
 */
export const describeTaskError = (error: TaskError): string => {
  switch (error._tag) {
    case "InvalidInput":
      return `Invalid input: ${error.message}`;
    case "TaskNotFound":
      return `Task ${error.id} not found`;
    case "CorruptTask":
      return `Stored data the app cannot read (${error.message}); ` +
        "fix or delete it with SQL, or reset";
    case "DatabaseError":
      return `Database error (${error.operation}): ${error.message}`;
  }
};
