// Shared contracts frozen by R0 from plan.md §9. Type-only Effect imports keep
// this module importable from the engine worker (a classic worker with no
// value imports) and from every adapter.
import type { Effect, PubSub, Scope, Stream } from "effect";

export type Engine = "sqlite" | "duckdb";
export type Interface = "web" | "cli" | "api";
/** DuckDB supports only "memory" | "opfs". */
export type Persistence = "memory" | "opfs-sahpool" | "opfs";

export type PrototypeConfig = {
  readonly name: string;
  readonly database: Engine;
  readonly persistence: Persistence;
  /** The database editor is always present and is not listed here. */
  readonly interfaces: readonly Interface[];
};

/**
 * In-process cell values, normalized: integers are `number` when safe and
 * `bigint` only when unsafe (both engines); blobs are `Uint8Array`.
 */
export type Cell = null | number | string | bigint | Uint8Array;

/** JSON form of a Cell for CLI/API/editor output; see encodeCell(). */
export type EncodedCell =
  | null
  | number
  | string
  | { readonly $type: "bigint"; readonly value: string }
  | { readonly $type: "blob"; readonly base64: string };

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** bigint -> {$type:"bigint",value}, blob -> {$type:"blob",base64}. */
export const encodeCell = (cell: Cell): EncodedCell => {
  if (typeof cell === "bigint") {
    return { $type: "bigint", value: cell.toString() };
  }
  if (cell instanceof Uint8Array) {
    return { $type: "blob", base64: bytesToBase64(cell) };
  }
  return cell;
};

/** Inverse of encodeCell(). */
export const decodeCell = (encoded: EncodedCell): Cell => {
  if (encoded !== null && typeof encoded === "object") {
    return encoded.$type === "bigint"
      ? BigInt(encoded.value)
      : base64ToBytes(encoded.base64);
  }
  return encoded;
};

export type DatabaseError = {
  readonly _tag: "DatabaseError";
  readonly operation:
    | "open"
    | "execute"
    | "tables"
    | "schema"
    | "reset"
    | "import"
    | "export"
    | "recover";
  readonly message: string;
  readonly cause: unknown;
};

export type QueryResult = {
  /** First result set; duplicate names allowed. */
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
  /** total_changes() delta, never sticky. */
  readonly changes: number;
  /** PRAGMA schema_version moved (SQLite); catalog diff (DuckDB). */
  readonly schemaChanged: boolean;
  readonly truncated: boolean;
};

export type Capability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export type DatabaseChange = {
  readonly kind: "write" | "reset" | "import";
  readonly source: "app" | "shell" | "host";
  readonly changes: number;
  readonly schemaChanged: boolean;
};

/** Engine-specific implementation remains accessible; no common SQL dialect. */
export interface DatabaseService {
  readonly engine: Engine;
  readonly version: string;
  readonly persistence: {
    readonly requested: Persistence;
    readonly actual: Persistence;
    readonly reason?: string;
  };
  readonly capabilities: {
    readonly persistence: Capability;
    readonly multiTab: Capability;
    readonly export: Capability;
    readonly import: Capability;
    readonly cancellation: Capability;
  };
  execute(
    sql: string,
    options?: { maxRows?: number; source?: DatabaseChange["source"] },
  ): Effect.Effect<QueryResult, DatabaseError>;
  tables(): Effect.Effect<readonly string[], DatabaseError>;
  schema(table: string): Effect.Effect<string, DatabaseError>;
  reset(): Effect.Effect<void, DatabaseError>;
  exportBytes(): Effect.Effect<Uint8Array, DatabaseError>;
  /** Header check + quick_check; restores the snapshot on failure. */
  importBytes(bytes: Uint8Array): Effect.Effect<void, DatabaseError>;
  readonly subscribe: Effect.Effect<
    PubSub.Subscription<DatabaseChange>,
    never,
    Scope.Scope
  >;
  /** Published only after success. */
  readonly changes: Stream.Stream<DatabaseChange>;
}

// ---------------------------------------------------------------------------
// Engine worker protocol (R0): one worker per prototype instance, message
// families on one port. D1 implements `exec`; DB0 implements `shell`. R0 adds
// the `lifecycle` family so the host can tell the worker where the vendored
// engine assets live and learn when the engine is up.
// ---------------------------------------------------------------------------

/** Engine facts reported once the worker has loaded and started the engine. */
export type EngineInfo = {
  readonly engine: Engine;
  readonly libversion: string;
  readonly sourceId: string;
  readonly filename: string;
  readonly vfs: string | null;
  /** Decimal string of the engine's native handle (sqlite3* for SQLite). */
  readonly handle: string;
  readonly prompt: string;
  readonly crossOriginIsolated: boolean;
};

export type WorkerRequest =
  | {
    readonly family: "lifecycle";
    readonly op: "init";
    /** Absolute or root-relative URL prefix ending in "/" for engine assets. */
    readonly vendorDir: string;
    /** Shell argv after argv[0]; defaults to Q17 (no -safe, no -bail). */
    readonly args?: readonly string[];
  }
  | {
    readonly family: "exec";
    readonly id: number;
    readonly sql: string;
    readonly maxRows?: number;
  }
  | {
    readonly family: "exec";
    readonly id: number;
    readonly op: "tables" | "schema" | "reset" | "export" | "import" | "open"; // "open" admitted by D1 (review M1)
    readonly arg?: unknown;
  }
  /** Complete statement or dot command. */
  | { readonly family: "shell"; readonly op: "submit"; readonly text: string }
  | { readonly family: "shell"; readonly op: "interrupt" };

export type WorkerEvent =
  | {
    readonly family: "lifecycle";
    readonly op: "ready";
    readonly info: EngineInfo;
  }
  | {
    readonly family: "lifecycle";
    readonly op: "error";
    readonly error: DatabaseError;
  }
  | {
    readonly family: "exec";
    readonly id: number;
    readonly ok: true;
    readonly result: QueryResult;
  }
  | {
    readonly family: "exec";
    readonly id: number;
    readonly ok: false;
    readonly error: DatabaseError;
  }
  | {
    readonly family: "shell";
    readonly op: "output";
    readonly stream: "stdout" | "stderr";
    readonly text: string;
  }
  | { readonly family: "shell"; readonly op: "prompt"; readonly text: string }
  /** From update_hook or post-submit diff. */
  | { readonly family: "change"; readonly change: DatabaseChange };

export type ShellError = {
  readonly _tag: "ShellError";
  readonly operation: "mount" | "ready" | "submit";
  readonly message: string;
  readonly cause: unknown;
};

/** What the common host needs from an engine's upstream console. */
export interface ShellBinding {
  /** Once per prototype instance. */
  mount(container: HTMLElement): Effect.Effect<void, ShellError, Scope.Scope>;
  readonly ready: Effect.Effect<void, ShellError>;
  /** SQLite: buffers until sqlite3_complete; DuckDB: the shell owns input. */
  submit(line: string): Effect.Effect<void, ShellError>;
  /** Upstream text, untouched. */
  readonly output: Stream.Stream<string>;
  /** Same engine instance, proven by tests. */
  readonly sharesDatabaseWith: DatabaseService;
}

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export type ApiHandler = (request: Request) => Promise<Response>;
