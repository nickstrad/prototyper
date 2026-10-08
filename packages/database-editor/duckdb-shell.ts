// Upstream DuckDB web shell binding for the DatabaseEditor host (DB1, plan.md
// §8/§9 ShellBinding, Q12/Q18, pocs/duckdb-shell/README.md). The real
// `@duckdb/duckdb-wasm-shell@1.32.0` (Rust→WASM rendering into xterm.js) is
// embedded once per prototype instance on D2's `AsyncDuckDB`
// (`resolveDatabase(service)`); the shell opens its own connection there and
// owns input, command handling and output. Nothing here interprets commands
// or formats results.
//
// Upstream facts this binding works around (all from the POC, re-executed in
// tests/database-editor-duckdb/):
// - The shell is a page singleton with no dispose API: a second `embed`
//   takes over the first terminal and every embed leaks xterm listeners. So
//   `embed` runs once per instance into one element the binding owns, and a
//   host mount only moves that element in and out of the host container.
//   Disposing the instance disposes the xterm Terminal (its listeners go
//   with it); D2's service then terminates the worker (`db.terminate()`).
// - The package exposes no terminal, input or output API. The binding learns
//   the xterm Terminal the shell constructs by wrapping the shell's own
//   wasm-bindgen `Terminal` constructor import while the shell module is
//   instantiated (once per page), then tees `Terminal.write` into `output`
//   untouched. `submit` types into the shell through xterm's own key path.
// - `.open` calls `AsyncDuckDB.open` on the shared instance and would drop
//   the app's tables; D2 blocks `open` on the instance (duckdb-engine.ts).
//   The shell then prints its own error for the refused call.
// - DuckDB has no update hook. The binding observes the shell's statements on
//   the shell's connection (`runQuery` on its connection id) and, after a
//   statement that is not read-only, reports a conservative `write` through
//   D2's `publishExternal` (which checkpoints OPFS), with DuckDB's own row
//   count where the result is a `Count` and a catalog diff for
//   `schemaChanged`. Reporting runs outside the service's permit; see
//   `observeShellStatements`.
import {
  createElement,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { Effect, Exit, Fiber, PubSub, Scope, Stream } from "effect";
import {
  type DatabaseChange,
  type DatabaseService,
  encodeCell,
  type EncodedCell,
  type Persistence,
  type ShellError,
} from "../core/types.ts";
import type { AsyncDuckDB } from "../database/duckdb-engine.ts";
import type { DuckDbHandle } from "../database/duckdb-service.ts";
import {
  DUCKDB_TASKS_SCHEMA,
  DUCKDB_TASKS_SEED,
} from "../database/duckdb-seed.ts";
import { DatabaseEditor } from "./DatabaseEditor.tsx";
import type { ShellBinding } from "./types.ts";

/** The pinned upstream shell (docs/integrations.md, Q13). */
export const DUCKDB_SHELL_PACKAGE = "@duckdb/duckdb-wasm-shell@1.32.0";

// Heavy modules load on first use only: a page that never opens a DuckDB
// view fetches none of the engine, the shell, its wasm or Arrow. Vite emits
// the shell's wasm into dist/assets (`?url`) and serves it from this origin.
const loadShell = async () => {
  const [shell, wasm] = await Promise.all([
    import("@duckdb/duckdb-wasm-shell"),
    import("@duckdb/duckdb-wasm-shell/dist/shell_bg.wasm?url"),
  ]);
  return { shell, wasmUrl: (wasm as { default: string }).default };
};
const loadService = () => import("../database/duckdb-service.ts");

/** The xterm 5.3 Terminal surface the binding reads (the shell's own). */
interface ShellTerminal {
  write(data: string | Uint8Array, callback?: () => void): void;
  dispose(): void;
  focus(): void;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly buffer: {
    readonly active: {
      readonly length: number;
      readonly baseY: number;
      readonly cursorY: number;
      getLine(y: number):
        | {
          readonly isWrapped: boolean;
          translateToString(trim?: boolean): string;
        }
        | undefined;
    };
  };
}

/** `AsyncDuckDB` methods the shell calls that D2's declarations omit. */
type ShellFacingDb = AsyncDuckDB & {
  connectInternal(): Promise<number>;
  disconnect(conn: number): Promise<null>;
  runQuery(conn: number, text: string): Promise<Uint8Array>;
};

/** Arrow table surface used to read a `Count` result. */
interface CountTable {
  readonly numRows: number;
  readonly schema: { readonly fields: readonly { readonly name: string }[] };
  getChildAt(index: number): { get(index: number): unknown } | null;
}

type Connection = Awaited<ReturnType<AsyncDuckDB["connect"]>>;

const shellError = (
  operation: ShellError["operation"],
  message: string,
  cause: unknown = null,
): ShellError => ({ _tag: "ShellError", operation, message, cause });

const fromUnknown = (operation: ShellError["operation"]) => (e: unknown) =>
  shellError(operation, e instanceof Error ? e.message : String(e), e);

// ---- the shell's terminal (page level) -----------------------------------------

/** xterm `lineHeight` for the shell's terminal (DOM renderer). */
const SHELL_LINE_HEIGHT = 1.2;

/** Receives the Terminal the shell constructs while an embed is running. */
let terminalSink: ((terminal: ShellTerminal) => void) | undefined;
/** The shell's import object is wrapped once per page (one wasm instance). */
let shellImportsWrapped = false;
/**
 * The shell module's own wasm exports (captured with its imports).
 * `configureDatabase(db)` is what `embed` calls to attach a database: it
 * reconnects the shell to `db`, reprints the banner and shows the prompt.
 */
let shellExports:
  | { readonly configureDatabase?: (db: unknown) => Promise<unknown> }
  | undefined;

/**
 * Wraps the shell's wasm-bindgen `Terminal` constructor import so the
 * Terminal it builds reaches `terminalSink`. Only the shell's import object
 * is touched (recognized by its constructor and key-handler imports).
 */
const wrapShellImports = (imports: unknown): boolean => {
  const wbg = (imports as { wbg?: Record<string, unknown> } | undefined)?.wbg;
  if (!wbg || shellImportsWrapped) return false;
  const keys = Object.keys(wbg);
  const construct = keys.find((k) => k.startsWith("__wbg_construct_"));
  const isShell = keys.some((k) =>
    k.startsWith("__wbg_attachCustomKeyEventHandler_")
  );
  if (construct === undefined || !isShell) return false;
  const original = wbg[construct] as (...args: unknown[]) => unknown;
  wbg[construct] = (...args: unknown[]) => {
    // xterm's DOM renderer (see `withoutWebGl2`) clips glyphs below the
    // baseline at the default line height: "_" vanished from `created_at`.
    // A taller cell is a rendering option only; the shell then fits its rows
    // to the container with it. The text written is untouched.
    const options = args[0] as Record<string, unknown> | undefined;
    if (options && typeof options === "object" && !("lineHeight" in options)) {
      options.lineHeight = SHELL_LINE_HEIGHT;
    }
    const terminal = original(...args);
    terminalSink?.(terminal as ShellTerminal);
    return terminal;
  };
  shellImportsWrapped = true;
  return true;
};

/** Keeps the shell's exports from an instantiate result. */
const keepShellExports = (result: unknown): unknown => {
  const r = result as {
    instance?: WebAssembly.Instance;
    exports?: WebAssembly.Exports;
  };
  shellExports = (r.instance?.exports ?? r.exports) as typeof shellExports;
  return result;
};

/**
 * Hides `WebGL2RenderingContext` until the shell has built its terminal, so
 * the shell's own `hasWebGL()` check picks xterm's DOM renderer (the path
 * upstream takes on Safari). With the WebGL addon, xterm 5.3's
 * `Terminal.dispose()` throws inside the addon's dispose
 * (`RenderService.setRenderer(undefined)`) and leaves the terminal's window
 * listeners and its WebGL context behind; the DOM renderer disposes cleanly.
 * Returns the (idempotent) restore function.
 */
const withoutWebGl2 = (): () => void => {
  const name = "WebGL2RenderingContext";
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (!descriptor?.configurable) return () => {};
  delete (globalThis as Record<string, unknown>)[name];
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    Object.defineProperty(globalThis, name, descriptor);
  };
};

/**
 * Runs `embed` with `WebAssembly.instantiate(Streaming)` observed, so the
 * shell's import object can be wrapped before its first instantiation. The
 * globals are restored as soon as `embed` settles.
 */
const observingShellImports = async <A>(embed: () => Promise<A>) => {
  const wasm = WebAssembly as unknown as Record<
    "instantiate" | "instantiateStreaming",
    (...args: unknown[]) => unknown
  >;
  const originals = {
    instantiate: wasm.instantiate,
    instantiateStreaming: wasm.instantiateStreaming,
  };
  const patched = {
    instantiate: (...args: unknown[]) => {
      const shell = wrapShellImports(args[1]);
      const result = Reflect.apply(originals.instantiate, WebAssembly, args);
      return shell
        ? (result as Promise<unknown>).then(keepShellExports)
        : result;
    },
    instantiateStreaming: (...args: unknown[]) => {
      const shell = wrapShellImports(args[1]);
      const result = Reflect.apply(
        originals.instantiateStreaming,
        WebAssembly,
        args,
      );
      return shell
        ? (result as Promise<unknown>).then(keepShellExports)
        : result;
    },
  };
  wasm.instantiate = patched.instantiate;
  wasm.instantiateStreaming = patched.instantiateStreaming;
  try {
    return await embed();
  } finally {
    for (const name of ["instantiate", "instantiateStreaming"] as const) {
      if (wasm[name] === patched[name]) wasm[name] = originals[name];
    }
  }
};

// ---- shell statements → change reports ------------------------------------------

/** DuckDB tokenizer token types (duckdb-wasm bindings/tokens.d.ts). */
const TOKEN = { OPERATOR: 3, KEYWORD: 4 } as const;

/** Leading words of statements that cannot change data or the catalog. */
const READ_ONLY = new Set([
  "SELECT",
  "FROM",
  "VALUES",
  "TABLE",
  "SHOW",
  "DESCRIBE",
  "SUMMARIZE",
  "(",
  // Opening or abandoning a transaction changes nothing another connection
  // can see; COMMIT is a write (it publishes the transaction's changes).
  "BEGIN",
  "START",
  "ROLLBACK",
  "ABORT",
  // Session settings.
  "SET",
  "RESET",
]);
const DML = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE"]);

type Plan = {
  readonly statements: number;
  readonly readOnly: boolean;
  /** One DML statement with RETURNING: its rows are the affected rows. */
  readonly returning: boolean;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * What a shell submission may do, from DuckDB's own tokenizer: statement
 * count and whether every statement is a read. Unknown leading words count
 * as writes (conservative).
 */
const planSubmission = async (db: AsyncDuckDB, text: string): Promise<Plan> => {
  const bytes = encoder.encode(text);
  const { offsets, types } = await db.tokenize(text);
  const word = (k: number) => {
    const raw = decoder.decode(
      bytes.subarray(offsets[k], offsets[k + 1] ?? bytes.length),
    ).trim();
    return (/^[A-Za-z_][A-Za-z0-9_]*/.exec(raw)?.[0] ?? raw.slice(0, 1))
      .toUpperCase();
  };
  const statements: { words: string[]; keywords: string[] }[] = [];
  let current = { words: [] as string[], keywords: [] as string[] };
  for (let k = 0; k < offsets.length; k++) {
    if (types[k] === TOKEN.OPERATOR && bytes[offsets[k]] === 0x3b) { // ';'
      if (current.words.length > 0) statements.push(current);
      current = { words: [], keywords: [] };
      continue;
    }
    current.words.push(word(k));
    if (types[k] === TOKEN.KEYWORD) current.keywords.push(word(k));
  }
  if (current.words.length > 0) statements.push(current);
  const readOnly = statements.every(({ words, keywords }) => {
    const head = words[0];
    if (head === "EXPLAIN") return words[1] !== "ANALYZE";
    if (head === "WITH") return !keywords.some((w) => DML.has(w));
    return READ_ONLY.has(head);
  });
  const only = statements.length === 1 ? statements[0] : undefined;
  return {
    statements: statements.length,
    readOnly,
    returning: only !== undefined && DML.has(only.words[0]) &&
      only.keywords.includes("RETURNING"),
  };
};

/** One line per catalog object (as duckdb-service.ts fingerprints it). */
const CATALOG_SQL =
  `SELECT coalesce(string_agg(x, chr(10) ORDER BY x), '') FROM (
  SELECT 't|' || database_name || '|' || schema_name || '|' || table_name || '|' || coalesce(sql, '') AS x FROM duckdb_tables() WHERE database_name IN (current_database(), 'temp')
  UNION ALL SELECT 'v|' || database_name || '|' || schema_name || '|' || view_name || '|' || coalesce(sql, '') FROM duckdb_views() WHERE NOT internal AND database_name IN (current_database(), 'temp')
  UNION ALL SELECT 'i|' || database_name || '|' || schema_name || '|' || index_name || '|' || coalesce(sql, '') FROM duckdb_indexes() WHERE database_name IN (current_database(), 'temp')
  UNION ALL SELECT 's|' || database_name || '|' || schema_name || '|' || sequence_name FROM duckdb_sequences() WHERE database_name IN (current_database(), 'temp')
  UNION ALL SELECT 'm|' || database_name || '|' || schema_name || '|' || function_name || '|' || coalesce(macro_definition, '') FROM duckdb_functions() WHERE NOT internal AND function_type IN ('macro', 'table_macro') AND database_name IN (current_database(), 'temp')
  UNION ALL SELECT 'y|' || database_name || '|' || schema_name || '|' || type_name FROM duckdb_types() WHERE NOT internal AND database_name IN (current_database(), 'temp')
  UNION ALL SELECT 'c|' || database_name || '|' || schema_name FROM duckdb_schemas() WHERE NOT internal AND database_name IN (current_database(), 'temp')
)`;

/** Reported for a write whose row count DuckDB does not give (COMMIT, ...). */
const UNCOUNTED_WRITE = 1;

type Observer = {
  /** Shell statements (and their change reports) in flight. */
  readonly pending: () => number;
  /** Change reports that failed (CHECKPOINT); also logged. */
  readonly reportErrors: string[];
  /** Restores the instance's methods and closes the catalog connection. */
  restore(): Promise<void>;
};

/**
 * Wraps `open`, `connect`, `connectInternal`, `disconnect` and `runQuery` on
 * the shared instance (own properties, like D2's `open` block) to tell the
 * shell's connections from the app's, to report the shell's writes and to
 * notice a refused `.open`.
 * `AsyncDuckDB.connect` calls `connectInternal` synchronously, so a
 * connection opened inside `connect` is the app's; any other is the shell's.
 *
 * Serialization decision: reports are not taken under the service's permit.
 * The shell's statements themselves run outside it (the shell owns its
 * connection), the worker executes one message at a time, and D2's
 * CHECKPOINT ignores only "other write transactions active" (a shell or app
 * transaction still open), so holding the permit would order only the event,
 * not the write. Each report is awaited before the shell sees its result, so
 * the shell prints its next prompt only after app views were notified.
 */
const observeShellStatements = async (
  handle: DuckDbHandle,
  onPending: () => void,
  onOpenRefused: () => void,
): Promise<Observer> => {
  const db = handle.db as ShellFacingDb;
  const catalogConn: Connection = await db.connect();
  // The package's own Arrow decoding, reused on the shell's result bytes.
  const Decoder = catalogConn.constructor as new (
    bindings: unknown,
    conn: number,
  ) => { query(text: string): Promise<CountTable> };
  const decode = (bytes: Uint8Array) =>
    new Decoder({
      runQuery: () => Promise.resolve(bytes),
      logger: { log() {} },
    }, 0).query("");
  const catalog = async (): Promise<string | null> => {
    try {
      const t = await catalogConn.query(CATALOG_SQL);
      return String(t.getChildAt(0)?.get(0));
    } catch {
      return null;
    }
  };
  const countOf = async (bytes: Uint8Array, plan: Plan): Promise<number> => {
    if (plan.statements !== 1) return UNCOUNTED_WRITE;
    const table = await decode(bytes);
    if (plan.returning) return table.numRows;
    const fields = table.schema.fields;
    if (fields.length === 1 && fields[0].name === "Count") {
      return table.numRows === 0 ? 0 : Number(table.getChildAt(0)?.get(0));
    }
    return UNCOUNTED_WRITE;
  };

  const shellConnections = new Set<number>();
  const reportErrors: string[] = [];
  let pending = 0;
  let appConnects = 0;
  const report = async (change: DatabaseChange) => {
    try {
      await handle.publishExternal(change);
    } catch (e) {
      const text = `shell write not reported: ${
        e instanceof Error ? e.message : String(e)
      }`;
      reportErrors.push(text);
      console.error(text);
    }
  };

  const original = {
    open: db.open,
    connect: db.connect,
    connectInternal: db.connectInternal,
    disconnect: db.disconnect,
    runQuery: db.runQuery,
  };
  const wrappers: Partial<ShellFacingDb> = {
    // D2's own block stays in charge: the call is refused exactly as before.
    // Upstream `.open` prints that error and then never re-enables input
    // (shell.rs `open_command` returns before `prompt()`), so the refusal
    // also asks the binding to re-attach the shell to this same instance
    // once the shell has printed it (after the current microtasks).
    open(this: ShellFacingDb, config) {
      return original.open.call(db, config).catch((e: unknown) => {
        setTimeout(onOpenRefused, 0);
        throw e;
      });
    },
    connect(this: ShellFacingDb) {
      appConnects++;
      try {
        return original.connect.call(db);
      } finally {
        appConnects--;
      }
    },
    async connectInternal(this: ShellFacingDb) {
      const app = appConnects > 0;
      const id = await original.connectInternal.call(db);
      if (!app) shellConnections.add(id);
      return id;
    },
    disconnect(this: ShellFacingDb, conn: number) {
      shellConnections.delete(conn);
      return original.disconnect.call(db, conn);
    },
    runQuery(this: ShellFacingDb, conn: number, text: string) {
      if (!shellConnections.has(conn)) {
        return original.runQuery.call(db, conn, text);
      }
      pending++;
      onPending();
      return (async () => {
        try {
          const plan = await planSubmission(db, text).catch((): Plan => ({
            statements: 2,
            readOnly: false,
            returning: false,
          }));
          // Posted before the shell's statement: the worker runs messages in
          // order, so this is the catalog before it.
          const before = plan.readOnly ? undefined : catalog();
          let bytes: Uint8Array;
          try {
            bytes = await original.runQuery.call(db, conn, text);
          } catch (e) {
            // One statement is atomic; a failing multi-statement submission
            // may have applied its earlier statements.
            if (!plan.readOnly) {
              const moved = (await before) !== (await catalog());
              if (plan.statements > 1 || moved) {
                await report({
                  kind: "write",
                  source: "shell",
                  changes: plan.statements > 1 ? UNCOUNTED_WRITE : 0,
                  schemaChanged: moved,
                });
              }
            }
            throw e;
          }
          if (!plan.readOnly) {
            const changes = await countOf(bytes, plan).catch(() =>
              UNCOUNTED_WRITE
            );
            const [a, b] = [await before, await catalog()];
            await report({
              kind: "write",
              source: "shell",
              changes,
              schemaChanged: a !== null && b !== null && a !== b,
            });
          }
          return bytes;
        } finally {
          pending--;
          onPending();
        }
      })();
    },
  };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(wrappers)) {
    saved.set(name, Object.getOwnPropertyDescriptor(db, name));
    Object.defineProperty(db, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return {
    pending: () => pending,
    reportErrors,
    restore: async () => {
      for (const [name, descriptor] of saved) {
        if (
          (db as unknown as Record<string, unknown>)[name] !==
            (wrappers as Record<string, unknown>)[name]
        ) continue;
        if (descriptor) Object.defineProperty(db, name, descriptor);
        else delete (db as unknown as Record<string, unknown>)[name];
      }
      // The shell keeps this instance and its connection id after the
      // instance is disposed, and disconnects it when the next instance is
      // embedded. By then D2 has terminated the worker, and the upstream call
      // would log "cannot send a message since the worker is not set!". A
      // terminated instance has nothing left to disconnect.
      Object.defineProperty(db, "disconnect", {
        configurable: true,
        writable: true,
        value: (conn: number) =>
          db.isDetached()
            ? Promise.resolve(null)
            : original.disconnect.call(db, conn),
      });
      await catalogConn.close().catch(() => undefined);
    },
  };
};

// ---- the binding ----------------------------------------------------------------

export interface DuckDbShellOptions {
  /** Terminal height inside the host (the shell fits xterm to it). */
  readonly height?: string;
  readonly backgroundColor?: string;
  readonly fontFamily?: string;
}

/** What the DuckDB binding exposes beyond ShellBinding (tests and hosts). */
export interface DuckDbShellBinding extends ShellBinding {
  readonly shellPackage: string;
  /** The element the shell renders into; hosts move it, never re-embed. */
  readonly element: HTMLDivElement;
  /** `embed()` calls made by this instance (1 once mounted). */
  readonly embeds: number;
  /** Host mounts so far (each moves `element` into the host). */
  readonly mounts: number;
  /** Prompts the shell has written (main or continuation) so far. */
  readonly prompts: number;
  /** Change reports that failed; see `observeShellStatements`. */
  readonly reportErrors: readonly string[];
  /** Errors thrown by the terminal's dispose (expected: none). */
  readonly disposeErrors: readonly string[];
  /** Terminal text, soft-wrapped rows joined ("" before the first mount). */
  screen(): string;
  /** Resolves when no shell statement or change report is in flight. */
  idle(): Promise<void>;
  focus(): void;
}

/** ANSI CSI sequences (the shell styles its prompt and banner). */
const CSI = new RegExp(`${"\u001b"}\\[[0-9;?]*[A-Za-z]`, "g");
const CLEAR_SCREEN = "\u001b[2J";
const CURSOR_HOME = "\u001b[H";
/** A write that ends with the shell's main or continuation prompt. */
const PROMPT_TAIL = /(duckdb|\.\.\.)> $/;

/** The one DuckDB shell per page (Q18): the instance that owns it. */
let pageOwner: symbol | undefined;

/**
 * Scoped DuckDB shell binding for one prototype instance on `service` (a D2
 * DuckDB service). Closing the scope disposes the shell's terminal, restores
 * the instance's methods and frees the page's shell slot; the worker belongs
 * to the service's scope (`db.terminate()` there).
 */
export const makeDuckDbShellBinding = (
  service: DatabaseService,
  options: DuckDbShellOptions = {},
): Effect.Effect<DuckDbShellBinding, ShellError, Scope.Scope> =>
  Effect.gen(function* () {
    const { duckDbHandle, resolveDatabase } = yield* Effect.tryPromise({
      try: loadService,
      catch: fromUnknown("ready"),
    });
    const handle = duckDbHandle(service);
    if (!handle) {
      return yield* Effect.fail(
        shellError("ready", "not a DuckDB DatabaseService (D2)"),
      );
    }
    const token = Symbol("duckdb-shell");
    yield* Effect.acquireRelease(
      Effect.suspend(() =>
        pageOwner === undefined
          ? Effect.sync(() => {
            pageOwner = token;
          })
          : Effect.fail(shellError(
            "mount",
            "the DuckDB web shell is a page singleton (plan.md Q18): dispose the other DuckDB prototype instance first",
          ))
      ),
      () =>
        Effect.sync(() => {
          if (pageOwner === token) pageOwner = undefined;
        }),
    );
    const output = yield* Effect.acquireRelease(
      PubSub.unbounded<string>(),
      PubSub.shutdown,
    );

    let idleWaiters: (() => void)[] = [];
    let pendingOf = () => 0;
    /** A re-attach after a refused `.open` (see `rearm`). */
    let rearming: Promise<void> | undefined;
    const isIdle = () => pendingOf() === 0 && rearming === undefined;
    const settle = () => {
      if (!isIdle()) return;
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    };
    const observer = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => observeShellStatements(handle, settle, () => void rearm()),
        catch: fromUnknown("ready"),
      }),
      (o) => Effect.promise(() => o.restore()),
    );
    pendingOf = observer.pending;

    const element = document.createElement("div");
    element.dataset.testid = "duckdb-shell";
    element.style.width = "100%";
    element.style.height = options.height ?? "420px";

    let terminal: ShellTerminal | undefined;
    let terminalDisposed = false;
    const disposeErrors: string[] = [];
    let disposed = false;
    let embeds = 0;
    let mounts = 0;
    /**
     * Host mounts currently holding the element, latest last. The element
     * sits in the latest holder's container. React StrictMode (and fast
     * hide/show) can release an earlier mount after a later one acquired, in
     * either order, so a release only moves the element to the holder that
     * is still active, or detaches it when none is.
     */
    let holders: { token: symbol; container: HTMLElement }[] = [];
    const place = () => {
      const top = holders.at(-1);
      if (!top) element.remove();
      else if (element.parentElement !== top.container) {
        top.container.appendChild(element);
      }
    };
    const release = (token: symbol) => {
      holders = holders.filter((h) => h.token !== token);
      if (!disposed) place();
    };
    let embedding: Promise<void> | undefined;
    /** Prompt writes seen; `submit` waits for the next one. */
    let prompts = 0;
    let promptWaiters: { after: number; resolve: () => void }[] = [];
    /** Set while re-attaching: the shell's screen clear is not passed on. */
    let keepScreen = false;

    /**
     * After a refused `.open` the shell has printed the refusal but keeps
     * input disabled. Its own `configureDatabase` (the call `embed` makes)
     * re-attaches it to the same instance: it reconnects, reprints its
     * banner and shows the prompt. Its clear-screen and cursor-home writes
     * are dropped so the refusal stays on screen above the banner.
     */
    const rearm = () =>
      rearming ??= (async () => {
        const configure = shellExports?.configureDatabase;
        if (!configure || disposed || !terminal) return;
        keepScreen = true;
        try {
          await configure(handle.db);
        } catch (e) {
          console.error(`DuckDB shell re-attach failed: ${String(e)}`);
        } finally {
          keepScreen = false;
        }
      })().finally(() => {
        rearming = undefined;
        settle();
      });

    const adopt = (t: ShellTerminal) => {
      if (terminal) return;
      terminal = t;
      const write = t.write.bind(t);
      t.write = (data, callback) => {
        if (disposed) return;
        const text = typeof data === "string" ? data : decoder.decode(data);
        if (keepScreen && (text === CLEAR_SCREEN || text === CURSOR_HOME)) {
          return;
        }
        Effect.runFork(PubSub.publish(output, text));
        write(data, callback);
        // The shell writes its prompt as the tail of a write.
        if (PROMPT_TAIL.test(text.replace(CSI, ""))) {
          prompts++;
          const ready = promptWaiters.filter((w) => w.after < prompts);
          promptWaiters = promptWaiters.filter((w) => w.after >= prompts);
          for (const w of ready) w.resolve();
        }
      };
    };

    /** Disposes the shell's terminal once; xterm drops its DOM listeners. */
    const disposeTerminal = () => {
      const t = terminal;
      if (!t || terminalDisposed) return;
      terminalDisposed = true;
      try {
        t.dispose();
      } catch (e) {
        disposeErrors.push(e instanceof Error ? e.message : String(e));
      }
    };

    const embedOnce = () =>
      embedding ??= (async () => {
        const { shell, wasmUrl } = await loadShell();
        embeds++;
        const restoreWebGl = withoutWebGl2();
        terminalSink = (t) => {
          restoreWebGl(); // the shell has made its renderer choice
          adopt(t);
        };
        try {
          await observingShellImports(() =>
            shell.embed({
              shellModule: wasmUrl,
              container: element,
              // D2 types the instance with local declarations.
              resolveDatabase: resolveDatabase(
                service,
              ) as unknown as Parameters<
                typeof shell.embed
              >[0]["resolveDatabase"],
              backgroundColor: options.backgroundColor ?? "#000000",
              fontFamily: options.fontFamily ?? "monospace",
            })
          );
        } finally {
          restoreWebGl();
          terminalSink = undefined;
        }
        if (!terminal) {
          throw new Error(
            "the DuckDB shell was initialized outside this binding; its terminal cannot be observed",
          );
        }
        // Disposed while the shell was starting: drop what it just built.
        if (disposed) disposeTerminal();
      })();

    yield* Scope.addFinalizer(
      yield* Scope.Scope,
      Effect.sync(() => {
        disposed = true;
        holders = [];
        element.remove();
        // The shell keeps a reference to the disposed terminal until the next
        // embed replaces it; nothing reaches it any more (element detached).
        disposeTerminal();
        for (const w of promptWaiters) w.resolve();
        promptWaiters = [];
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
      }),
    );

    const idle = () =>
      isIdle()
        ? Promise.resolve()
        : new Promise<void>((resolve) => idleWaiters.push(resolve));
    const nextPrompt = (after: number) =>
      disposed || prompts > after
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
          promptWaiters.push({ after, resolve })
        );

    /** One key into xterm's key path, where the shell's handler reads it. */
    const press = (key: string) => {
      const target = terminal?.textarea;
      if (!target) throw new Error("the DuckDB shell is not mounted");
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    };
    let chain: Promise<unknown> = Promise.resolve();
    const submitLines = (text: string) => {
      const next = chain.then(async () => {
        if (embedding) await embedding;
        await idle();
        for (const line of text.split("\n")) {
          const seen = prompts;
          for (const ch of line) press(ch);
          press("Enter");
          await nextPrompt(seen);
          await idle();
        }
      });
      chain = next.catch(() => {});
      return next;
    };

    const binding: DuckDbShellBinding = {
      shellPackage: DUCKDB_SHELL_PACKAGE,
      element,
      get embeds() {
        return embeds;
      },
      get mounts() {
        return mounts;
      },
      get prompts() {
        return prompts;
      },
      reportErrors: observer.reportErrors,
      disposeErrors,
      sharesDatabaseWith: service,
      output: Stream.fromPubSub(output),
      ready: Effect.tryPromise({
        try: () => loadShell(),
        catch: fromUnknown("ready"),
      }).pipe(Effect.asVoid),
      mount: (container) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              if (disposed) throw new Error("the DuckDB shell was disposed");
              const token = Symbol("mount");
              holders.push({ token, container });
              mounts++;
              place();
              try {
                await embedOnce();
              } catch (e) {
                release(token);
                throw e;
              }
              return token;
            },
            catch: fromUnknown("mount"),
          }),
          (token) => Effect.sync(() => release(token)),
        ).pipe(Effect.asVoid),
      submit: (line) =>
        Effect.tryPromise({
          try: () => submitLines(line),
          catch: fromUnknown("submit"),
        }),
      screen: () => {
        if (!terminal) return "";
        const buffer = terminal.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) {
          const line = buffer.getLine(i);
          const text = line?.translateToString(true) ?? "";
          if (line?.isWrapped && lines.length > 0) {
            lines[lines.length - 1] += text;
          } else lines.push(text);
        }
        return lines.join("\n").replace(/\n+$/, "");
      },
      idle,
      focus: () => terminal?.focus(),
    };
    return binding;
  });

// ---- one prototype instance -------------------------------------------------------

export interface DuckDbShellRuntimeOptions extends DuckDbShellOptions {
  readonly persistence?: Persistence;
  readonly name?: string;
  readonly fresh?: boolean;
  readonly schema?: string;
  readonly seed?: string;
}

export interface DuckDbShellRuntime {
  readonly service: DatabaseService;
  readonly handle: DuckDbHandle;
  readonly binding: DuckDbShellBinding;
}

/**
 * Scoped acquisition of one DuckDB prototype instance: D2's service (the
 * worker, the database and the app connection) and the shell binding on it.
 * Closing the scope disposes the shell's terminal first, then D2 closes the
 * app connection and terminates the worker (`db.terminate()`).
 */
export const duckDbShellRuntime = (
  options: DuckDbShellRuntimeOptions = {},
): Effect.Effect<DuckDbShellRuntime, ShellError, Scope.Scope> =>
  Effect.gen(function* () {
    const { make, duckDbHandle } = yield* Effect.tryPromise({
      try: loadService,
      catch: fromUnknown("ready"),
    });
    const service = yield* make({
      persistence: options.persistence ?? "memory",
      name: options.name ?? "prototype",
      fresh: options.fresh,
      schema: options.schema ?? DUCKDB_TASKS_SCHEMA,
      seed: options.seed ?? DUCKDB_TASKS_SEED,
    }).pipe(
      Effect.mapError((e) => shellError("ready", e.message, e)),
    );
    const binding = yield* makeDuckDbShellBinding(service, options);
    return { service, handle: duckDbHandle(service)!, binding };
  });

// ---- playground workbench ---------------------------------------------------------

/** JSON-safe QueryResult for page.evaluate (bigint/blob via encodeCell). */
export interface EncodedQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly EncodedCell[])[];
  readonly changes: number;
  readonly schemaChanged: boolean;
  readonly truncated: boolean;
}

/** `window.__playground.db1` (tests/database-editor-duckdb/*.spec.ts). */
export interface Db1Hooks {
  /** Starts the playground's DuckDB prototype instance (lazy). */
  open(): Promise<void>;
  readonly runtime: DuckDbShellRuntime | undefined;
  /** Change events seen by the workbench since `open`, in order. */
  readonly changes: readonly DatabaseChange[];
  /** `binding.output` chunks since `open` (the shell's own writes). */
  readonly output: readonly string[];
  /** App-side statements through the service (source "app"). */
  execute(sql: string): Promise<EncodedQueryResult>;
  tables(): Promise<readonly string[]>;
  reset(): Promise<void>;
  submit(line: string): Promise<void>;
  screen(): string;
  idle(): Promise<void>;
  /** Closes the instance: terminal disposed, worker terminated. */
  dispose(): Promise<void>;
}

type WorkbenchState =
  | { phase: "closed" }
  | { phase: "loading" }
  | { phase: "ready"; runtime: DuckDbShellRuntime }
  | { phase: "disposed" }
  | { phase: "failed"; message: string };

const h = createElement;

/** A subscribed application view: task titles, refreshed on every change. */
function AppView({ service }: { service: DatabaseService }): ReactElement {
  const [rows, setRows] = useState<readonly string[]>([]);
  const [refreshes, setRefreshes] = useState(0);
  useEffect(() => {
    const load = () =>
      Effect.runPromise(
        service.execute("SELECT id, title FROM tasks ORDER BY id"),
      ).then(
        (r) => {
          setRows(r.rows.map((row) => `${String(row[0])}: ${String(row[1])}`));
          setRefreshes((n) => n + 1);
        },
        (e: { message?: string }) => setRows([`error: ${e.message ?? e}`]),
      );
    void load();
    const fiber = Effect.runFork(
      Stream.runForEach(() => Effect.sync(() => void load()))(service.changes),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [service]);
  return h(
    "div",
    { style: { fontSize: 12, margin: "8px 0" } },
    h("strong", null, "App view (tasks via the service): "),
    h("span", { "data-testid": "db1-app-refreshes" }, `${refreshes} loads`),
    h(
      "ul",
      { "data-testid": "db1-app-view", style: { margin: "4px 0" } },
      rows.map((r) => h("li", { key: r }, r)),
    ),
  );
}

/**
 * Playground mount for DB1: a button starts one DuckDB prototype instance
 * (D2 service + this binding) and mounts the common DatabaseEditor host on
 * it; "Hide" unmounts the host without touching the shell or the engine.
 * Nothing DuckDB-related loads before "Open".
 */
export function DuckDbShellWorkbench(): ReactElement {
  const [state, setState] = useState<WorkbenchState>({ phase: "closed" });
  const [visible, setVisible] = useState(true);
  const openRef = useRef<() => Promise<void>>(undefined);

  useEffect(() => {
    let scope: Scope.Closeable | undefined;
    let runtime: DuckDbShellRuntime | undefined;
    let opening: Promise<void> | undefined;
    const changes: DatabaseChange[] = [];
    const output: string[] = [];
    let collectors: Fiber.Fiber<void>[] = [];
    const persistence = new URLSearchParams(globalThis.location?.search ?? "")
        .get("db1") === "opfs"
      ? "opfs"
      : "memory";
    const need = () => {
      if (!runtime) throw new Error("the DuckDB instance is not open");
      return runtime;
    };
    /** Bumped by `dispose`; a start from an earlier epoch is not shown. */
    let epoch = 0;
    const dispose = async () => {
      epoch++;
      // Closed while DuckDB is still starting: let the start finish, then
      // close it as a whole. Closing its scope mid-start would terminate the
      // worker under D2's startup, which then logs every call it still makes.
      await opening?.catch(() => undefined);
      const s = scope;
      scope = undefined;
      runtime = undefined;
      for (const fiber of collectors) Effect.runFork(Fiber.interrupt(fiber));
      collectors = [];
      if (s) {
        setState({ phase: "disposed" });
        await Effect.runPromise(Scope.close(s, Exit.void));
      }
    };
    const open = () =>
      opening ??= (async () => {
        const started = epoch;
        setState({ phase: "loading" });
        const s = Effect.runSync(Scope.make());
        scope = s;
        let acquired: DuckDbShellRuntime;
        try {
          acquired = await Effect.runPromise(
            Scope.provide(s)(duckDbShellRuntime({
              persistence,
              name: "db1-playground",
            })),
          );
        } catch (e) {
          scope = undefined;
          await Effect.runPromise(Scope.close(s, Exit.void));
          if (epoch !== started) return; // disposed while starting
          const message = (e as { message?: string }).message ?? String(e);
          setState({ phase: "failed", message });
          throw e;
        } finally {
          opening = undefined;
        }
        // Disposed while starting: `dispose` closes the scope (kept in
        // `scope`) once this start has settled.
        if (epoch !== started) return;
        runtime = acquired;
        changes.length = 0;
        output.length = 0;
        collectors = [
          Effect.runFork(
            Stream.runForEach((change: DatabaseChange) =>
              Effect.sync(() => {
                changes.push(change);
              })
            )(acquired.service.changes),
          ),
          Effect.runFork(
            Stream.runForEach((text: string) =>
              Effect.sync(() => {
                output.push(text);
              })
            )(acquired.binding.output),
          ),
        ];
        setState({ phase: "ready", runtime: acquired });
      })();
    const hooks: Db1Hooks = {
      open,
      get runtime() {
        return runtime;
      },
      changes,
      output,
      execute: (sql) =>
        Effect.runPromise(need().service.execute(sql)).then((r) => ({
          ...r,
          rows: r.rows.map((row) => row.map(encodeCell)),
        })),
      tables: () => Effect.runPromise(need().service.tables()),
      reset: () => Effect.runPromise(need().service.reset()),
      submit: (line) => Effect.runPromise(need().binding.submit(line)),
      screen: () => runtime?.binding.screen() ?? "",
      idle: () => runtime?.binding.idle() ?? Promise.resolve(),
      dispose,
    };
    const target = globalThis as { __playground?: Record<string, unknown> };
    // App creates `__playground` in its own effect, after this child's.
    const attach = () => {
      if (!target.__playground) return false;
      target.__playground.db1 = hooks;
      return true;
    };
    const timer = attach() ? undefined : setInterval(() => {
      if (attach()) clearInterval(timer);
    }, 20);
    openRef.current = open;
    return () => {
      if (timer !== undefined) clearInterval(timer);
      if (target.__playground?.db1 === hooks) delete target.__playground.db1;
      void dispose();
    };
  }, []);

  const openNow = () => void openRef.current?.().catch(() => undefined);

  return h(
    "section",
    {
      "data-testid": "db1-workbench",
      style: { fontFamily: "system-ui, sans-serif" },
    },
    h(
      "h2",
      { style: { fontSize: 16 } },
      "Database editor (DB1: upstream DuckDB shell on the live database) ",
      state.phase === "closed" || state.phase === "disposed"
        ? h("button", {
          type: "button",
          "data-testid": "db1-open",
          onClick: openNow,
        }, "Open DuckDB database view")
        : h("button", {
          type: "button",
          "data-testid": "db1-toggle",
          disabled: state.phase !== "ready",
          onClick: () => setVisible((v) => !v),
        }, visible ? "Hide database view" : "Show database view"),
    ),
    h(
      "p",
      { "data-testid": "db1-status", style: { fontSize: 12, margin: "4px 0" } },
      state.phase === "closed" && "DuckDB not loaded",
      state.phase === "loading" && "starting DuckDB…",
      state.phase === "failed" && `editor failed: ${state.message}`,
      state.phase === "disposed" &&
        "instance disposed (terminal disposed, worker terminated)",
      state.phase === "ready" &&
        `engine ready · DuckDB ${state.runtime.service.version} · ${state.runtime.binding.shellPackage}`,
    ),
    state.phase === "ready" && h(AppView, { service: state.runtime.service }),
    state.phase === "ready" && visible &&
      h(DatabaseEditor, {
        binding: state.runtime.binding,
        title: "DuckDB prototype database",
      }),
  );
}
