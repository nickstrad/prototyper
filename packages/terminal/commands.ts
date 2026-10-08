// Standard database commands for the application terminal, reusable by every
// prototype: `db` works on any §9 DatabaseService (SQLite or DuckDB), resolved
// through a runtime the caller supplies. Hand it the prototype's shared
// DatabaseService (as the task manager does) and terminal writes reach the
// UI's `changes` stream. `db` is an application-shell command: it never
// stands in for the upstream engine console (the DatabaseEditor). JSON output
// encodes cells with encodeCell(); expected failures (DatabaseError) map to
// stderr + exit 1, usage errors to exit 2. Portable: no DOM, React, xterm or
// Deno APIs.
import { Effect, type ManagedRuntime } from "effect";
import type { CustomCommand } from "just-bash";
import {
  type Cell,
  type DatabaseChange,
  type DatabaseError,
  type DatabaseService,
  encodeCell,
  type QueryResult,
} from "../core/types.ts";
import {
  command,
  type CommandResult,
  fail,
  runEffectCommand,
} from "./effect-command.ts";

export const DB_USAGE = "usage: db <command>\n" +
  "  db info [--json]          engine, version and persistence\n" +
  "  db tables [--json]        table names, one per line\n" +
  "  db schema TABLE           the table's CREATE statement\n" +
  "  db sql [--json] 'SQL'     run SQL (quote it: the shell sees > ; * | etc.;\n" +
  "                            several arguments are joined by spaces; no\n" +
  "                            argument reads stdin)\n" +
  "  db reset                  restore the prototype's schema and seed data\n";

/** Rows `db sql` prints before reporting truncation on stderr. */
export const DB_SQL_MAX_ROWS = 1000;

export interface DatabaseCommandOptions {
  /** Command name; default "db". */
  readonly name?: string;
  /** Change-event source for `db sql` writes; default "shell". */
  readonly source?: DatabaseChange["source"];
  /** Row limit for `db sql`; default DB_SQL_MAX_ROWS. */
  readonly maxRows?: number;
}

/** `db sql --json` output: the first result set with JSON-safe cells. */
export const encodeResult = (result: QueryResult) => ({
  columns: result.columns,
  rows: result.rows.map((row) => row.map(encodeCell)),
  changes: result.changes,
  schemaChanged: result.schemaChanged,
  truncated: result.truncated,
});

/**
 * Text that cannot break a TSV row: backslash, tab, newline and carriage
 * return are written as `\\`, `\t`, `\n` and `\r` (use `--json` for exact
 * values).
 */
export const escapeTsv = (text: string): string =>
  text.replace(
    /[\\\t\n\r]/g,
    (c) => ({ "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r" })[c]!,
  );

/**
 * One cell as text: NULL, numbers, bigint digits, blob as x'hex', strings
 * through escapeTsv().
 */
export const cellText = (cell: Cell): string => {
  if (cell === null) return "NULL";
  if (cell instanceof Uint8Array) {
    return "x'" +
      Array.from(cell, (b) => b.toString(16).padStart(2, "0")).join("") + "'";
  }
  return escapeTsv(String(cell));
};

/** Tab-separated header + rows, or a change count for statements without rows. */
const resultText = (r: QueryResult): string =>
  r.columns.length === 0
    ? `changes: ${r.changes}\n`
    : [r.columns.map(escapeTsv), ...r.rows.map((row) => row.map(cellText))]
      .map((cells) => cells.join("\t") + "\n").join("");

const json = (value: unknown) => JSON.stringify(value) + "\n";

/** Splits `--json` out of the arguments (anywhere before a `--`). */
export const takeJsonFlag = (
  args: readonly string[],
): { readonly json: boolean; readonly rest: readonly string[] } => {
  const end = args.indexOf("--");
  const head = end < 0 ? args : args.slice(0, end);
  const tail = end < 0 ? [] : args.slice(end + 1);
  return {
    json: head.includes("--json"),
    rest: [...head.filter((a) => a !== "--json"), ...tail],
  };
};

const formatError = (name: string) => (e: DatabaseError): string =>
  `${name}: database error (${e.operation}): ${e.message}\n`;

/**
 * Runs one `db info|tables|schema|sql|reset` invocation (argv after the
 * command name is `args`) on the DatabaseService `service` resolves to
 * inside `runtime`. Pass the prototype's shared runtime so every interface
 * works on the same instance; a write here is published on the service's
 * `changes` stream like any other.
 */
export const runDatabaseCommand = <R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  service: Effect.Effect<DatabaseService, never, R>,
  args: readonly string[],
  stdin: string,
  options: DatabaseCommandOptions = {},
): Promise<CommandResult> => {
  const name = options.name ?? "db";
  const usage = DB_USAGE.replaceAll("db ", `${name} `);
  const program = (
    args: readonly string[],
    stdin: string,
    onTruncated: () => void,
  ): Effect.Effect<string, DatabaseError, R> | string => {
    const [sub, ...raw] = args;
    const { json: asJson, rest } = takeJsonFlag(raw);
    const on = <A>(
      f: (db: DatabaseService) => Effect.Effect<A, DatabaseError>,
    ) => Effect.flatMap(service, f);
    switch (sub) {
      case "info":
        if (rest.length > 0) return `${name} info: unexpected arguments\n`;
        return on((db) =>
          Effect.succeed(
            asJson
              ? json({
                engine: db.engine,
                version: db.version,
                persistence: db.persistence,
              })
              : `${db.engine} ${db.version} · persistence ${db.persistence.actual}` +
                (db.persistence.actual === db.persistence.requested
                  ? ""
                  : ` (requested ${db.persistence.requested}${
                    db.persistence.reason ? `: ${db.persistence.reason}` : ""
                  })`) +
                "\n",
          )
        );
      case "tables":
        if (rest.length > 0) return `${name} tables: unexpected arguments\n`;
        return on((db) =>
          Effect.map(
            db.tables(),
            (ts) => asJson ? json(ts) : ts.map((t) => t + "\n").join(""),
          )
        );
      case "schema":
        if (rest.length !== 1 || asJson) {
          return `${name} schema: expected exactly one TABLE\n`;
        }
        return on((db) => Effect.map(db.schema(rest[0]), (s) => s + "\n"));
      case "sql": {
        const sql = (rest.length > 0 ? rest.join(" ") : stdin).trim();
        if (!sql) return `${name} sql: no SQL given (arguments or stdin)\n`;
        return on((db) =>
          db.execute(sql, {
            maxRows: options.maxRows ?? DB_SQL_MAX_ROWS,
            source: options.source ?? "shell",
          })
        ).pipe(
          Effect.tap((r) =>
            r.truncated ? Effect.sync(onTruncated) : Effect.void
          ),
          Effect.map((r) => asJson ? json(encodeResult(r)) : resultText(r)),
        );
      }
      case "reset":
        if (rest.length > 0 || asJson) {
          return `${name} reset: unexpected arguments\n`;
        }
        return on((db) =>
          Effect.as(db.reset(), "database reset to its seed data\n")
        );
      default:
        return usage;
    }
  };
  let truncated = false;
  const p = program(args, stdin, () => truncated = true);
  if (typeof p === "string") {
    return Promise.resolve(fail(p === usage ? usage : p + usage, 2));
  }
  // Truncation is not a failure, but the reader must see it.
  return runEffectCommand(runtime, p, formatError(name)).then((r) =>
    truncated
      ? {
        ...r,
        stderr: `${name} sql: output truncated to ${
          options.maxRows ?? DB_SQL_MAX_ROWS
        } rows\n`,
      }
      : r
  );
};

/** `db ...` (or `options.name`) as a just-bash command; see runDatabaseCommand. */
export const databaseCommand = <R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  service: Effect.Effect<DatabaseService, never, R>,
  options: DatabaseCommandOptions = {},
): CustomCommand =>
  command(
    options.name ?? "db",
    (args, stdin) => runDatabaseCommand(runtime, service, args, stdin, options),
  );

/**
 * `base` with every command whose name appears in `extra` replaced by the
 * `extra` one (e.g. a prototype's real `tasks` over R0's example).
 */
export const mergeCommands = (
  base: readonly CustomCommand[],
  extra: readonly CustomCommand[],
): CustomCommand[] => {
  const names = new Set(extra.map((c) => c.name));
  return [...base.filter((c) => !names.has(c.name)), ...extra];
};
