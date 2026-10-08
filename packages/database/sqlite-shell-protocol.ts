// DB0-local extension of the engine worker's `shell` family (plan.md §9).
// The frozen protocol in packages/core/types.ts has `submit` and `interrupt`
// only; the DatabaseEditor host also needs a structured path onto the shell's
// own `sqlite3*` (`fiddle_db_handle()`) for its table list, schema view,
// reset, export and import, and the bridge test ("app write visible in the
// shell, shell write visible to the app") needs it before D1's `exec` family
// lands. These ops are answered with raw WASM exports on the same handle, as
// pocs/sqlite-shell did. Main decides at integration whether to fold them
// into §9 or retire them in favour of D1's service (see the DB0 report).
import type { Cell, DatabaseError, QueryResult } from "../core/types.ts";

/** Fixed continuation prompt: `fiddle_get_prompt` exposes only the main one. */
export const CONTINUATION_PROMPT = "   ...> ";

export type SqliteShellOpRequest =
  | {
    readonly family: "shell";
    readonly op: "query";
    readonly id: number;
    readonly sql: string;
    readonly params?: readonly Cell[];
    readonly maxRows?: number;
  }
  | { readonly family: "shell"; readonly op: "reset"; readonly id: number }
  | { readonly family: "shell"; readonly op: "export"; readonly id: number }
  | {
    readonly family: "shell";
    readonly op: "import";
    readonly id: number;
    readonly bytes: Uint8Array;
  };

export type SqliteShellQueryValue = QueryResult & {
  readonly lastInsertRowid: number;
  readonly autocommit: boolean;
  /** Counters after the call; the adapter diffs them to detect shell writes. */
  readonly totalChanges: number;
  readonly schemaVersion: number;
  /** `fiddle_db_handle()` after the call, as a decimal string. */
  readonly handle: string;
};

export type SqliteShellHandleValue = {
  readonly handle: string;
  readonly filename: string;
};

export type SqliteShellExportValue = SqliteShellHandleValue & {
  readonly bytes: Uint8Array;
};

export type SqliteShellOpValue =
  | SqliteShellQueryValue
  | SqliteShellHandleValue
  | SqliteShellExportValue;

export type SqliteShellOpEvent =
  | {
    readonly family: "shell";
    readonly op: "reply";
    readonly id: number;
    readonly ok: true;
    readonly value: SqliteShellOpValue;
  }
  | {
    readonly family: "shell";
    readonly op: "reply";
    readonly id: number;
    readonly ok: false;
    readonly error: DatabaseError;
  };

export const isSqliteShellOpEvent = (
  message: unknown,
): message is SqliteShellOpEvent => {
  const m = message as { family?: unknown; op?: unknown; id?: unknown };
  return typeof m === "object" && m !== null && m.family === "shell" &&
    m.op === "reply" && typeof m.id === "number";
};
