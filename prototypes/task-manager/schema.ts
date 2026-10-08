// Task manager schema (project.md §11): the SQL table, the Effect Schemas
// that validate external input (titles, ids, patches) and decode stored rows,
// and the tagged errors every interface maps at its boundary (project.md §5).
// Portable: no DOM, Deno or React imports.
import { Schema } from "effect";

/** The tasks table, exactly as project.md §11 specifies it. */
export const TASKS_TABLE_SQL = `CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`;

export const TITLE_MAX_LENGTH = 200;

/**
 * Characters a title may not contain: every Unicode control character
 * (general category Cc: C0, DEL, C1 such as U+0085) and the bidirectional
 * formatting controls (U+061C, U+200E/F, U+202A-E, U+2066-9) that can make a
 * title display differently from what is stored.
 */
export const FORBIDDEN_TITLE_CHARS =
  /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * A task title as typed by a person: surrounding whitespace is trimmed, then
 * it must be non-empty, at most TITLE_MAX_LENGTH UTF-16 units, free of
 * FORBIDDEN_TITLE_CHARS and well-formed UTF-16 (no lone surrogates). Titles
 * are single-line and are inlined as SQL string literals, so NUL must never
 * reach the engine.
 */
export const Title = Schema.Trim.check(
  Schema.isNonEmpty({ message: "title is required" }),
  Schema.isMaxLength(TITLE_MAX_LENGTH, {
    message: `title must be at most ${TITLE_MAX_LENGTH} characters`,
  }),
  Schema.makeFilter((s: string) => !FORBIDDEN_TITLE_CHARS.test(s), {
    message: "title must not contain control or bidi characters",
  }),
  Schema.makeFilter((s: string) => s.isWellFormed(), {
    message: "title must not contain lone surrogates",
  }),
);

/** A task id: a positive safe integer. */
export const TaskId = Schema.Number.check(
  Schema.isInt({ message: "id must be an integer" }),
  Schema.isGreaterThan(0, { message: "id must be positive" }),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER, {
    message: "id is too large",
  }),
);

/** PATCH semantics: change the title, the completed flag, or both. */
export const TaskPatch = Schema.Struct({
  title: Schema.optionalKey(Title),
  completed: Schema.optionalKey(Schema.Boolean),
});
export type TaskPatch = typeof TaskPatch.Type;

/** A task as every interface sees it. */
export const Task = Schema.Struct({
  id: TaskId,
  title: Schema.String,
  completed: Schema.Boolean,
  createdAt: Schema.String,
});
export type Task = typeof Task.Type;

/**
 * One `SELECT id, title, completed, created_at` row as QueryResult cells.
 * Writes made with SQL outside the app are not validated by it, so stored
 * rows are decoded too; `completed` must be 0 or 1.
 */
export const TaskRow = Schema.Tuple([
  TaskId,
  Schema.String,
  Schema.Literals([0, 1]),
  Schema.String,
]);

/** The column list every query selects, in TaskRow order. */
export const TASK_COLUMNS = "id, title, completed, created_at";

// ---- expected failures -------------------------------------------------------

/** Input rejected by a schema; `message` is safe to show to a person. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  { message: Schema.String },
) {}

/**
 * Stored rows the app cannot read (written outside it, e.g. `completed = 7`).
 * `ids` are the rowids as text (they may be beyond the safe-integer range).
 * Nothing was written by the failing operation; the rows can be fixed or
 * deleted with SQL (database editor, workbench) or by a reset.
 */
export class CorruptTask extends Schema.TaggedError<CorruptTask>()(
  "CorruptTask",
  { ids: Schema.Array(Schema.String), message: Schema.String },
) {}

/** No task with this id (never existed, or already deleted). */
export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()(
  "TaskNotFound",
  { id: Schema.Number },
) {}
