// Engine worker skeleton (plan.md §9, R0). One worker owns one Fiddle WASM
// instance, which is both the upstream sqlite3 shell and the browser SQLite
// engine. This file is a CLASSIC worker: it must contain no value imports,
// because it loads the vendored bundle with importScripts(), which module
// workers do not support. Type-only imports are erased by the bundler.
//
// R0 implements the `lifecycle` family (load the vendored module, start the
// shell with Q17 argv, report engine facts). The `exec` family is stubbed for
// D1 and the `shell` family is stubbed for DB0; both answer with protocol-
// shaped "not implemented" responses so hosts can already be wired up.
// Type-only aliases keep this file a script (no `import`/`export`): a module
// would make the bundler emit `export {}` and classic workers reject that.
type DatabaseError = import("../core/types.ts").DatabaseError;
type EngineInfo = import("../core/types.ts").EngineInfo;
type WorkerEvent = import("../core/types.ts").WorkerEvent;
type WorkerRequest = import("../core/types.ts").WorkerRequest;
type FiddleSqlite3 = import("./worker-fiddle-types.ts").FiddleSqlite3;
type Sqlite3InitModule = import("./worker-fiddle-types.ts").Sqlite3InitModule;

declare function importScripts(...urls: string[]): void;
// Defined as a global by fiddle-module.js once importScripts() has run.
declare const sqlite3InitModule: Sqlite3InitModule;

interface WorkerScope {
  postMessage(message: WorkerEvent): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  onerror: ((...args: unknown[]) => void) | null;
  readonly crossOriginIsolated: boolean;
}
const scope = self as unknown as WorkerScope;

/** Q17: no `-safe` (makes .open read-only, blocks OPFS), no `-bail`. */
const DEFAULT_ARGS: readonly string[] = ["/fiddle.sqlite3"];

type Phase = "new" | "loading" | "ready" | "failed" | "dead";
let phase: Phase = "new";
let sqlite3: FiddleSqlite3 | undefined;
let info: EngineInfo | undefined;

const post = (event: WorkerEvent) => scope.postMessage(event);

const dbError = (
  operation: DatabaseError["operation"],
  message: string,
  cause: unknown = null,
): DatabaseError => ({ _tag: "DatabaseError", operation, message, cause });

const shellOutput = (stream: "stdout" | "stderr") => (...parts: unknown[]) =>
  post({ family: "shell", op: "output", stream, text: parts.join(" ") });

const describe = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// ---- lifecycle ------------------------------------------------------------

const vfsName = (s: FiddleSqlite3, schema = "main"): string | null => {
  const p = s.wasm.xWrap("fiddle_db_vfs", "*", ["string"])(schema) as number;
  if (!p) return null;
  const vfs = new s.capi.sqlite3_vfs(p);
  try {
    return s.wasm.cstrToJs(vfs.$zName);
  } finally {
    vfs.dispose();
  }
};

const dbFilename = (s: FiddleSqlite3): string =>
  (s.wasm.xWrap("fiddle_db_filename", "string", ["string"])(0) as
    | string
    | null) ?? "";

const prompt = (s: FiddleSqlite3): string =>
  s.wasm.xWrap("fiddle_get_prompt", "string:dealloc", [])() as string;

const startShell = (s: FiddleSqlite3, args: readonly string[]) => {
  const argv = ["sqlite3-fiddle.wasm", ...args];
  s.capi.sqlite3_shutdown(); // upstream fiddle-worker.js does the same
  const pArgv = s.wasm.allocMainArgv(argv); // leaked on purpose: main() keeps it
  const rc = s.wasm.exports.fiddle_main(argv.length, pArgv);
  if (rc !== 0) throw new Error(`fiddle_main returned ${rc}`);
};

const init = async (vendorDir: string, args: readonly string[]) => {
  if (phase !== "new") {
    post({
      family: "lifecycle",
      op: "error",
      error: dbError("open", `init called while ${phase}`),
    });
    return;
  }
  phase = "loading";
  try {
    importScripts(vendorDir + "fiddle-module.js");
    const s = await sqlite3InitModule({
      print: shellOutput("stdout"),
      printErr: shellOutput("stderr"),
      locateFile: (path) => vendorDir + path,
      setStatus: () => {},
    });
    startShell(s, args);
    sqlite3 = s;
    info = {
      engine: "sqlite",
      libversion: s.capi.sqlite3_libversion(),
      sourceId: s.capi.sqlite3_sourceid(),
      filename: dbFilename(s),
      vfs: vfsName(s),
      handle: String(s.wasm.exports.fiddle_db_handle()),
      prompt: prompt(s),
      crossOriginIsolated: scope.crossOriginIsolated === true,
    };
    phase = "ready";
    post({ family: "lifecycle", op: "ready", info });
  } catch (e) {
    phase = "failed";
    post({
      family: "lifecycle",
      op: "error",
      error: dbError("open", `engine init failed: ${describe(e)}`, describe(e)),
    });
  }
};

// ---- exec family (D1) ----
// Structured access to the shell's own sqlite3* (fiddle_db_handle(), re-read
// on every request because shell `.open` can swap it; POC gotcha 8) through
// the bundled OO1 API. Cells leave the worker raw (number | bigint | string |
// Uint8Array | null); the main thread normalizes them with the shared
// normalizer in sqlite-cells.ts, which a classic worker cannot import.
//
// Ops: exec{sql,maxRows}, tables, schema{arg:table}, reset (fiddle_reset_db:
// same handle, empty database), export, import{arg:bytes} (validated on a
// private copy, then copied in with the backup API: same handle, same VFS),
// and the D1 extension "open"{arg:{persistence,fresh}} that picks the VFS
// before the shell's lazy first open. Every reply is a QueryResult.
//
// Change events: update/commit hooks on the handle only schedule a flush;
// the flush runs after each synchronous shell submission, and once no
// transaction is open it posts {family:"change", source:"shell"} for the
// total_changes()/schema_version delta. Writes made by the exec family are
// reported by the service from the exec reply, never as change events.
type D1Sqlite3 = import("./worker-fiddle-types.ts").FiddleD1Sqlite3;
type D1Db = import("./worker-fiddle-types.ts").FiddleOo1Db;
type D1Result = import("../core/types.ts").QueryResult;
type D1Persistence = import("../core/types.ts").Persistence;
type D1ExecRequest = Extract<WorkerRequest, { family: "exec" }>;

const D1_MAX_ROWS = 1000;
const D1_SQLITE_DONE = 101;
const D1_SQLITE_TRANSIENT = -1;

let d1Wrapped: { handle: number; db: D1Db } | undefined;
let d1HookedHandle = 0;
let d1Baseline = { total: 0, schema: 0 };
let d1InExec = false;
let d1FlushPending = false;
let d1Persistence:
  | { requested: D1Persistence; actual: D1Persistence; reason: string }
  | undefined;

class D1Failure extends Error {
  constructor(message: string, readonly detail: Record<string, unknown>) {
    super(message);
  }
}

const d1Api = () => sqlite3 as unknown as D1Sqlite3;
const d1Handle = (): number => d1Api().wasm.exports.fiddle_db_handle();

const d1Result = (
  columns: string[],
  rows: unknown[][],
  extra: Partial<Pick<D1Result, "changes" | "schemaChanged">> = {},
): D1Result => ({
  columns,
  rows: rows as D1Result["rows"],
  changes: extra.changes ?? 0,
  schemaChanged: extra.schemaChanged ?? false,
  truncated: false,
});

/** Opens the shell's database lazily, the same way a first submission would. */
const d1ForceShellOpen = () => {
  if (d1Handle()) return;
  // An unknown PRAGMA is a silent no-op: it makes the shell call open_db()
  // without printing anything or touching the shell's state.
  const s = d1Api();
  const p = s.wasm.allocCString("PRAGMA prototyper_open;");
  try {
    s.wasm.exports.fiddle_exec(p);
  } finally {
    s.wasm.dealloc(p);
  }
  if (!d1Handle()) throw new Error("the shell did not open its database");
};

const d1Db = (): D1Db => {
  d1ForceShellOpen();
  const handle = d1Handle();
  if (d1Wrapped?.handle !== handle) {
    d1Wrapped?.db.close(); // non-owning wrapper: the shell keeps the handle
    d1Wrapped = { handle, db: d1Api().oo1.DB.wrapHandle(handle, false) };
  }
  d1ArmHooks(handle, d1Wrapped.db);
  return d1Wrapped.db;
};

const d1Counters = (db: D1Db) => ({
  total: Number(d1Api().capi.sqlite3_total_changes64(db.pointer)),
  schema: Number(db.selectValue("PRAGMA schema_version")),
});

const d1ArmHooks = (handle: number, db: D1Db) => {
  if (d1HookedHandle === handle) return;
  const { capi } = d1Api();
  // Hooks must not run SQL; they only schedule a flush. Returning non-zero
  // from a commit hook would turn the COMMIT into a ROLLBACK.
  capi.sqlite3_update_hook(handle, () => d1Dirty(), 0);
  capi.sqlite3_commit_hook(handle, () => {
    d1Dirty();
    return 0;
  }, 0);
  d1HookedHandle = handle;
  d1Baseline = d1Counters(db);
};

const d1Dirty = () => {
  if (d1InExec || d1FlushPending) return;
  d1FlushPending = true;
  // A microtask runs right after the current (synchronous) shell submission,
  // so each submission is reported on its own.
  queueMicrotask(d1Flush);
};

const d1Flush = () => {
  if (!d1FlushPending) return;
  d1FlushPending = false;
  if (phase !== "ready" || !d1Handle()) return;
  const db = d1Db();
  // Inside an open transaction: wait for the commit hook (or a later exec).
  if (!d1Api().capi.sqlite3_get_autocommit(db.pointer)) return;
  const now = d1Counters(db);
  const changes = now.total - d1Baseline.total;
  const schemaChanged = now.schema !== d1Baseline.schema;
  d1Baseline = now;
  if (changes > 0 || schemaChanged) {
    post({
      family: "change",
      change: { kind: "write", source: "shell", changes, schemaChanged },
    });
  }
};

const d1Execute = (db: D1Db, sql: string, maxRows: number): D1Result => {
  const before = d1Counters(db);
  const columns: string[] = [];
  const rows: unknown[][] = [];
  let truncated = false;
  try {
    db.exec({
      sql,
      rowMode: "array",
      columnNames: columns,
      callback: (row) => {
        if (rows.length >= maxRows) {
          truncated = true;
          return false; // stops this statement; later statements still run
        }
        rows.push(row);
      },
    });
  } catch (e) {
    const after = d1Counters(db);
    throw new D1Failure(describe(e), {
      resultCode: (e as { resultCode?: number }).resultCode ?? null,
      changes: after.total - before.total,
      schemaChanged: after.schema !== before.schema,
    });
  }
  const after = d1Counters(db);
  return {
    columns,
    rows: rows as D1Result["rows"],
    changes: after.total - before.total,
    schemaChanged: after.schema !== before.schema,
    truncated,
  };
};

const d1Schema = (db: D1Db, table: string): D1Result => {
  const s = d1Api();
  const stmt = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?");
  const p = s.wasm.allocCString(table);
  try {
    const rc = s.wasm.exports.sqlite3_bind_text(
      stmt.pointer,
      1,
      p,
      new TextEncoder().encode(table).length,
      D1_SQLITE_TRANSIENT,
    );
    if (rc !== 0) {
      throw new Error(`bind failed: ${s.capi.sqlite3_js_rc_str(rc)}`);
    }
    if (!stmt.step()) throw new Error(`no such table: ${table}`);
    return d1Result(["sql"], [[stmt.get(0)]]);
  } finally {
    s.wasm.dealloc(p);
    stmt.finalize();
  }
};

/** Validates an image on a private memory copy, then backs it up into db. */
const d1Import = (db: D1Db, bytes: unknown): D1Result => {
  if (!(bytes instanceof Uint8Array)) throw new Error("import expects bytes");
  const header = String.fromCharCode(...bytes.subarray(0, 16));
  if (bytes.length < 512 || header !== "SQLite format 3\0") {
    throw new Error("not an SQLite database image (bad header)");
  }
  const s = d1Api();
  const { capi } = s;
  const tmp = new s.oo1.DB(":memory:", "c");
  try {
    const p = s.wasm.allocFromTypedArray(bytes);
    const rc = capi.sqlite3_deserialize(
      tmp.pointer,
      "main",
      p,
      bytes.byteLength,
      bytes.byteLength,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    if (rc !== 0) {
      s.wasm.dealloc(p);
      throw new Error(
        `sqlite3_deserialize failed: ${capi.sqlite3_js_rc_str(rc)}`,
      );
    }
    // sqlite3_deserialize accepts garbage after a valid header.
    const check = tmp.selectValue("PRAGMA quick_check");
    if (check !== "ok") {
      throw new Error(`imported image failed quick_check: ${String(check)}`);
    }
    const backup = capi.sqlite3_backup_init(
      db.pointer,
      "main",
      tmp.pointer,
      "main",
    );
    if (!backup) {
      throw new Error(`backup failed: ${capi.sqlite3_errmsg(db.pointer)}`);
    }
    const step = capi.sqlite3_backup_step(backup, -1);
    const done = capi.sqlite3_backup_finish(backup);
    if (step !== D1_SQLITE_DONE || done !== 0) {
      throw new Error(
        `backup failed: ${
          capi.sqlite3_js_rc_str(step === D1_SQLITE_DONE ? done : step)
        }`,
      );
    }
  } finally {
    tmp.close();
  }
  return d1Result([], [], { schemaChanged: true });
};

const d1Vfs = (): string | null => vfsName(sqlite3!);

/** D1 extension op: choose the VFS before the shell's lazy first open. */
const d1OpenDb = async (arg: unknown): Promise<D1Result> => {
  const s = d1Api();
  const opts = (arg ?? {}) as { persistence?: D1Persistence; fresh?: boolean };
  const requested = opts.persistence ?? "memory";
  if (!d1Persistence) {
    let actual: D1Persistence = "memory";
    let reason = requested === "memory" ? "memory requested" : "";
    if (requested === "opfs") {
      reason =
        "opfs/opfs-wl are deferred (plan Q15; need COOP/COEP); using memory";
    } else if (requested === "opfs-sahpool" && d1Handle()) {
      reason =
        "the shell opened its database before persistence was configured";
    } else if (requested === "opfs-sahpool") {
      try {
        const pool = await s.installOpfsSAHPoolVfs({});
        const sah = s.capi.sqlite3_vfs_find(pool.vfsName);
        const previous = s.capi.sqlite3_vfs_find(null);
        // The shell opens /fiddle.sqlite3 with the default VFS; make the pool
        // the default only for that open.
        s.capi.sqlite3_vfs_register(sah, 1);
        try {
          d1ForceShellOpen();
        } finally {
          s.capi.sqlite3_vfs_register(previous, 1);
        }
        if (d1Vfs() === pool.vfsName) {
          actual = "opfs-sahpool";
          reason = "";
        } else {
          reason =
            `the shell database opened on ${d1Vfs()}, not ${pool.vfsName}`;
        }
      } catch (e) {
        const name = (e as { name?: string }).name;
        reason = name === "NoModificationAllowedError"
          ? `open in another tab (${describe(e)})`
          : `opfs-sahpool unavailable: ${describe(e)}`;
      }
    }
    d1Persistence = { requested, actual, reason };
  }
  const db = d1Db();
  if (opts.fresh) s.wasm.exports.fiddle_reset_db();
  const p = d1Persistence;
  return d1Result(
    ["requested", "actual", "reason", "vfs", "filename", "handle", "version"],
    [[
      p.requested,
      p.actual,
      p.reason,
      d1Vfs(),
      dbFilename(sqlite3!),
      String(db.pointer),
      s.capi.sqlite3_libversion(),
    ]],
  );
};

const d1Run = async (req: D1ExecRequest): Promise<D1Result> => {
  const op = "op" in req ? (req.op as string) : "execute";
  if (op === "open") return await d1OpenDb((req as { arg?: unknown }).arg);
  const db = d1Db();
  switch (op) {
    case "execute":
      return d1Execute(
        db,
        (req as { sql: string }).sql,
        (req as { maxRows?: number }).maxRows ?? D1_MAX_ROWS,
      );
    case "tables":
      return d1Execute(
        db,
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        Number.MAX_SAFE_INTEGER,
      );
    case "schema":
      return d1Schema(db, String((req as { arg?: unknown }).arg));
    case "reset":
      d1Api().wasm.exports.fiddle_reset_db();
      return d1Result([], [], { schemaChanged: true });
    case "export":
      return d1Result(["bytes"], [[
        d1Api().capi.sqlite3_js_db_export(db.pointer),
      ]]);
    case "import":
      return d1Import(db, (req as { arg?: unknown }).arg);
    default:
      throw new Error(`unknown exec op "${op}"`);
  }
};

const d1Operation = (req: D1ExecRequest): DatabaseError["operation"] => {
  const op = "op" in req ? (req.op as string) : "execute";
  return op === "open"
    ? "open"
    : (["tables", "schema", "reset", "import", "export"].includes(op)
      ? op
      : "execute") as DatabaseError["operation"];
};

const execFamily = async (req: D1ExecRequest) => {
  const operation = d1Operation(req);
  if (phase !== "ready" || !sqlite3) {
    post({
      family: "exec",
      id: req.id,
      ok: false,
      error: dbError(
        operation,
        `engine is ${phase}; exec "${operation}" rejected`,
      ),
    });
    return;
  }
  // Report shell writes that happened before this request first.
  d1Flush();
  d1InExec = true;
  try {
    const result = await d1Run(req);
    post({ family: "exec", id: req.id, ok: true, result });
  } catch (e) {
    const detail = e instanceof D1Failure
      ? e.detail
      : { name: (e as { name?: string })?.name ?? null };
    post({
      family: "exec",
      id: req.id,
      ok: false,
      error: dbError(operation, describe(e), detail),
    });
  } finally {
    // Exec-family writes are reported by the service, not as change events.
    if (d1Handle() && d1Wrapped) d1Baseline = d1Counters(d1Db());
    d1InExec = false;
  }
};
// ---- end exec family ----

// ---- shell family (stub; DB0 implements) ----------------------------------

const shellStub = (req: Extract<WorkerRequest, { family: "shell" }>) => {
  post({
    family: "shell",
    op: "output",
    stream: "stderr",
    text: phase === "ready"
      ? `shell family is not implemented in R0 (op "${req.op}"); DB0 implements it`
      : `engine is ${phase}; shell "${req.op}" rejected`,
  });
  if (sqlite3) post({ family: "shell", op: "prompt", text: prompt(sqlite3) });
};

// ---- dispatch ---------------------------------------------------------------

scope.onmessage = (event) => {
  const req = event.data;
  switch (req.family) {
    case "lifecycle":
      void init(req.vendorDir, req.args ?? DEFAULT_ARGS);
      return;
    case "exec":
      void execFamily(req);
      return;
    case "shell":
      shellStub(req);
      return;
  }
};

// Emscripten raises ExitStatus if the shell ever calls exit(); the instance is
// unusable afterwards.
scope.onerror = (...args) => {
  const err = args[4] as { name?: string; message?: string } | undefined;
  if (err && err.name === "ExitStatus") {
    phase = "dead";
    shellOutput("stderr")(`FATAL: shell exited: ${err.message}`);
  }
};
