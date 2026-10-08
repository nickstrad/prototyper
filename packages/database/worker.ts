// Engine worker skeleton (plan.md §9, R0). One worker owns one Fiddle WASM
// instance, which is both the upstream sqlite3 shell and the browser SQLite
// engine. This file is a CLASSIC worker: it must contain no value imports,
// because it loads the vendored bundle with importScripts(), which module
// workers do not support. Type-only imports are erased by the bundler.
//
// R0 implements the `lifecycle` family (load the vendored module, start the
// shell with Q17 argv, report engine facts). D1 implements the `exec` family
// (structured queries on the shell's own handle) and DB0 the `shell` family
// (input plumbing for the upstream shell); each lives in its delimited block.
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

// ---- shell family (DB0) ----
// The upstream sqlite3 shell. `submit` feeds `fiddle_exec`, which treats each
// call as a complete input stream: trailing SQL without ";" runs at end of
// input, so continuation lines cannot be fed one at a time (POC gotcha 2).
// Typed lines are buffered here the way shell.c process_input() decides when
// to run: a dot or "#" line with no pending SQL goes straight through; SQL
// accumulates until the upstream `sqlite3_complete` export accepts it, or a
// lone "/" or "go" line completes it (line_is_command_terminator). The shell
// still executes the whole buffer; nothing is split or interpreted here. A
// buffered line answers with a fixed continuation prompt because
// fiddle_get_prompt exposes only the main prompt. `.open` is refused with a
// visible message (plan.md Q17): it would swap the shell's sqlite3* away from
// the prototype's live database. The dot-command echo (`puts(zSql)` in
// fiddle_exec) is de-duplicated by the binding on the main thread.
//
// DB0-local ops (sqlite-shell-protocol.ts): query/reset/export/import run on
// fiddle_db_handle() through raw exports, as pocs/sqlite-shell did, so the
// DatabaseEditor host and the bridge test have a structured path before D1's
// service is wired in. They post no change events: the DB0 adapter diffs
// total_changes/schema_version on the main thread, so D1's hook-based events
// are never duplicated.
type ShellSqlite3 = import("./worker-fiddle-types.ts").FiddleShellSqlite3;
type ShellRequest = Extract<WorkerRequest, { family: "shell" }>;
type ShellOpRequest = import("./sqlite-shell-protocol.ts").SqliteShellOpRequest;
type ShellOpEvent = import("./sqlite-shell-protocol.ts").SqliteShellOpEvent;
type ShellOpValue = import("./sqlite-shell-protocol.ts").SqliteShellOpValue;
type ShellCell = import("../core/types.ts").Cell;

const SHELL_CONTINUATION_PROMPT = "   ...> ";
const SHELL_SQLITE_ROW = 100;
const SHELL_SQLITE_DONE = 101;
const SHELL_MAX_ROWS = 1000;
const SHELL_OPS: readonly string[] = ["query", "reset", "export", "import"];
/**
 * Dot commands the host refuses because they move `fiddle_db_handle()` away
 * from the prototype's live database: `.open` (upstream accepts any prefix of
 * length >= 2) and `.connection` (any prefix; `.c`/`.co` reach it because
 * `.changes`/`.check` need three letters and `.clone` is compiled out).
 * Matching is case-sensitive like upstream `cli_strncmp`.
 */
const SHELL_BLOCKED_COMMANDS: readonly { name: string; minPrefix: number }[] = [
  { name: "open", minPrefix: 2 },
  { name: "connection", minPrefix: 1 },
];

/** shell.c IsSpace(): isspace() on ASCII. */
const SHELL_SPACE = /[ \t\n\v\f\r]/;

/**
 * The first argument of a dot-command line, derived like upstream
 * parseDotCmdArgs() (shell.c.in:9889-9938 at 4bfc6e53a9): trailing
 * whitespace and one trailing ";" are trimmed, whitespace after the dot is
 * skipped, and the word is either a quoted token ('...' or "...", with
 * backslash escapes resolved inside double quotes) or a run of non-space
 * characters. Returns null when the line holds no command word.
 */
const shellDotWord = (line: string): string | null => {
  let end = line.length;
  while (end > 0 && SHELL_SPACE.test(line[end - 1])) end--;
  if (end > 0 && line[end - 1] === ";") {
    end--;
    while (end > 0 && SHELL_SPACE.test(line[end - 1])) end--;
  }
  let h = 1;
  while (h < end && SHELL_SPACE.test(line[h])) h++;
  if (h >= end) return null;
  const delim = line[h];
  if (delim === "'" || delim === '"') {
    h++;
    const start = h;
    while (h < end && line[h] !== delim) {
      if (line[h] === "\\" && delim === '"' && h + 1 < end) h++;
      h++;
    }
    const raw = line.slice(start, h);
    // Upstream keeps the resolved token in a C string: a resolved NUL
    // (`\x` with no digits, `\0`, `\x00`, `\000`) ends the token there.
    return shellCString(delim === '"' ? shellResolveBackslashes(raw) : raw);
  }
  const start = h;
  while (h < end && !SHELL_SPACE.test(line[h])) h++;
  return line.slice(start, h);
};

/** What a C string holds: everything before the first NUL. */
const shellCString = (text: string): string => {
  const nul = text.indexOf("\0");
  return nul < 0 ? text : text.slice(0, nul);
};

/**
 * shell.c resolve_backslashes(): the escapes a double-quoted token allows.
 * Only for command-word matching: `String.fromCharCode(byte)` for bytes >=
 * 0x80 yields a Latin-1 character, not the UTF-8 byte upstream keeps, so do
 * not reuse this helper for argument values.
 */
const shellResolveBackslashes = (z: string): string => {
  const simple: Record<string, string> = {
    a: "\x07",
    b: "\b",
    t: "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
    '"': '"',
    "'": "'",
    "\\": "\\",
  };
  let out = "";
  for (let i = 0; i < z.length; i++) {
    let c = z[i];
    if (c === "\\" && i + 1 < z.length) {
      c = z[++i];
      if (c in simple) {
        out += simple[c];
      } else if (c === "x") {
        let hex = "";
        while (hex.length < 2 && /[0-9a-fA-F]/.test(z[i + 1] ?? "")) {
          hex += z[++i];
        }
        out += String.fromCharCode(parseInt(hex || "0", 16) & 0xff);
      } else if (c >= "0" && c <= "7") {
        let oct = c;
        while (oct.length < 3 && /[0-7]/.test(z[i + 1] ?? "")) oct += z[++i];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      } else {
        out += c;
      }
    } else {
      out += c;
    }
  }
  return out;
};

/** The blocked command a line would run, or null. */
const shellBlockedCommand = (line: string): string | null => {
  if (!line.startsWith(".")) return null;
  const word = shellDotWord(line);
  if (word === null) return null;
  for (const { name, minPrefix } of SHELL_BLOCKED_COMMANDS) {
    if (word.length >= minPrefix && name.startsWith(word)) return name;
  }
  return null;
};

/** Two stderr lines so the message never wraps in a 100-column terminal. */
const shellBlockedMessage = (command: string): readonly string[] => [
  `Error: ".${command}" is disabled in this console.`,
  "The prototype's live database stays attached; use the host's Reset or Import controls instead.",
];

/** Typed SQL lines not yet accepted by sqlite3_complete. */
let shellPending = "";
let shellLastHandle = 0;
const shellDecoder = new TextDecoder();

const shellApi = () => sqlite3 as unknown as ShellSqlite3;
const shellHandle = (): number => shellApi().wasm.exports.fiddle_db_handle();
const shellStderr = shellOutput("stderr");

const shellPostPrompt = (text: string = prompt(sqlite3!)) =>
  post({ family: "shell", op: "prompt", text });

const shellExec = (text: string) => {
  const { wasm } = shellApi();
  const p = wasm.allocCString(text);
  try {
    wasm.exports.fiddle_exec(p);
  } finally {
    wasm.dealloc(p);
  }
};

/** Upstream completeness check (not a splitter; the shell runs the buffer). */
const shellComplete = (text: string): boolean => {
  const { wasm } = shellApi();
  const p = wasm.allocCString(text);
  try {
    return wasm.exports.sqlite3_complete(p) === 1;
  } finally {
    wasm.dealloc(p);
  }
};

/**
 * Hands one unit to the shell and reports the main prompt afterwards. Every
 * line of the unit is checked first: process_input() would run a blocked dot
 * command on any later line once the SQL before it has finished.
 */
const shellRun = (unit: string) => {
  // allocCString() hands the shell a C string: a raw NUL ends the input there.
  const text = shellCString(unit);
  // Conservative: a multi-line string literal whose continuation line starts
  // with a blocked word (e.g. ".op") is refused too, although the shell would
  // have treated it as SQL text.
  for (const line of text.split(/\r?\n/)) {
    const blocked = shellBlockedCommand(line);
    if (blocked !== null) {
      for (const message of shellBlockedMessage(blocked)) shellStderr(message);
      shellPostPrompt();
      return;
    }
  }
  try {
    shellExec(text);
  } catch (e) {
    // Emscripten's ExitStatus must reach scope.onerror (phase "dead").
    if ((e as { name?: string })?.name === "ExitStatus") throw e;
    shellStderr(`shell error: ${describe(e)}`);
  }
  const handle = shellHandle();
  if (shellLastHandle !== 0 && handle !== shellLastHandle) {
    shellStderr(
      `notice: the shell's database connection changed (handle ${shellLastHandle} -> ${handle})`,
    );
  }
  shellLastHandle = handle;
  shellPostPrompt();
};

const shellSubmit = (text: string) => {
  if (phase !== "ready" || !sqlite3) {
    shellStderr(`engine is ${phase}; shell input rejected`);
    if (sqlite3) shellPostPrompt();
    return;
  }
  // The engine receives a C string, so nothing after a raw NUL exists for it.
  const line = shellCString(text).replace(/\r?\n$/, "");
  if (shellPending === "") {
    if (line.trim() === "") {
      shellPostPrompt();
      return;
    }
    if (line.startsWith(".") || line.startsWith("#")) {
      shellRun(line);
      return;
    }
  }
  // shell.c: a lone "/" or "go" ends the statement when the SQL so far plus
  // ";" is complete; the shell itself turns that line into ";".
  const terminated = /^\s*(\/|go)\s*$/i.test(line) &&
    shellComplete(shellPending + ";");
  shellPending = shellPending === "" ? line : `${shellPending}\n${line}`;
  if (
    terminated ||
    (shellPending.includes(";") && shellComplete(shellPending))
  ) {
    const unit = shellPending;
    shellPending = "";
    shellRun(unit);
  } else {
    shellPostPrompt(SHELL_CONTINUATION_PROMPT);
  }
};

/** Opens the shell's database lazily, as a first submission would. */
const shellEnsureOpen = () => {
  if (shellHandle()) return;
  // An unknown PRAGMA is a silent no-op that makes the shell call open_db().
  shellExec("PRAGMA prototyper_open;");
  if (!shellHandle()) throw new Error("the shell did not open its database");
};

const shellErrmsg = (pDb: number): string =>
  shellApi().wasm.cstrToJs(shellApi().wasm.exports.sqlite3_errmsg(pDb));

const shellBind = (pStmt: number, params: readonly ShellCell[]) => {
  const { wasm, capi } = shellApi();
  const X = wasm.exports;
  params.forEach((v, i) => {
    const idx = i + 1;
    let rc: number;
    if (v === null || v === undefined) rc = X.sqlite3_bind_null(pStmt, idx);
    else if (typeof v === "bigint") rc = X.sqlite3_bind_int64(pStmt, idx, v);
    else if (typeof v === "number") {
      rc = Number.isInteger(v)
        ? X.sqlite3_bind_int64(pStmt, idx, BigInt(v))
        : X.sqlite3_bind_double(pStmt, idx, v);
    } else if (v instanceof Uint8Array) {
      const p = wasm.allocFromTypedArray(v);
      rc = X.sqlite3_bind_blob(
        pStmt,
        idx,
        p,
        v.length,
        capi.SQLITE_WASM_DEALLOC,
      );
    } else {
      // Raw export: capi.sqlite3_bind_text throws on JS strings (plan.md §9).
      const [p, n] = wasm.allocCString(String(v), true);
      rc = X.sqlite3_bind_text(pStmt, idx, p, n, capi.SQLITE_WASM_DEALLOC);
    }
    if (rc !== 0) throw new Error(`bind ${idx} failed: rc=${rc}`);
  });
};

const shellColumn = (pStmt: number, i: number): ShellCell => {
  const { wasm } = shellApi();
  const X = wasm.exports;
  switch (X.sqlite3_column_type(pStmt, i)) {
    case 1: {
      const v = X.sqlite3_column_int64(pStmt, i);
      return v >= BigInt(Number.MIN_SAFE_INTEGER) &&
          v <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(v)
        : v;
    }
    case 2:
      return X.sqlite3_column_double(pStmt, i);
    case 3: {
      const p = X.sqlite3_column_text(pStmt, i);
      const n = X.sqlite3_column_bytes(pStmt, i);
      return shellDecoder.decode(wasm.heap8u().slice(p, p + n));
    }
    case 4: {
      const p = X.sqlite3_column_blob(pStmt, i);
      const n = X.sqlite3_column_bytes(pStmt, i);
      return n ? wasm.heap8u().slice(p, p + n) : new Uint8Array();
    }
    default:
      return null;
  }
};

/** Prepares and steps every statement in `sql`; keeps the first result set. */
const shellRows = (
  pDb: number,
  sql: string,
  params: readonly ShellCell[],
  maxRows: number,
) => {
  const { wasm } = shellApi();
  const X = wasm.exports;
  const [pSql, nSql] = wasm.allocCString(sql, true);
  const ppStmt = wasm.alloc(wasm.ptr.size);
  const pzTail = wasm.alloc(wasm.ptr.size);
  let columns: string[] = [];
  let rows: ShellCell[][] = [];
  let truncated = false;
  let bound = false;
  let seenResultSet = false;
  try {
    let cur = pSql;
    const end = pSql + nSql;
    while (cur < end) {
      wasm.pokePtr(ppStmt, 0);
      let rc = X.sqlite3_prepare_v2(pDb, cur, end - cur, ppStmt, pzTail);
      if (rc !== 0) throw new Error(shellErrmsg(pDb));
      const pStmt = wasm.peekPtr(ppStmt);
      cur = wasm.peekPtr(pzTail);
      if (!pStmt) continue; // whitespace or a comment
      try {
        if (!bound && X.sqlite3_bind_parameter_count(pStmt) > 0) {
          shellBind(pStmt, params);
          bound = true;
        }
        const nCol = X.sqlite3_column_count(pStmt);
        const cols: string[] = [];
        for (let i = 0; i < nCol; i++) {
          cols.push(wasm.cstrToJs(X.sqlite3_column_name(pStmt, i)));
        }
        const out: ShellCell[][] = [];
        let cut = false;
        while ((rc = X.sqlite3_step(pStmt)) === SHELL_SQLITE_ROW) {
          if (out.length >= maxRows) {
            cut = true;
            continue; // keep stepping so the statement completes
          }
          const row: ShellCell[] = [];
          for (let i = 0; i < nCol; i++) row.push(shellColumn(pStmt, i));
          out.push(row);
        }
        if (rc !== SHELL_SQLITE_DONE) throw new Error(shellErrmsg(pDb));
        if (nCol > 0 && !seenResultSet) {
          seenResultSet = true;
          columns = cols;
          rows = out;
          truncated = cut;
        }
      } finally {
        X.sqlite3_finalize(pStmt);
      }
    }
  } finally {
    wasm.dealloc(pSql);
    wasm.dealloc(ppStmt);
    wasm.dealloc(pzTail);
  }
  return { columns, rows, truncated };
};

const shellCounters = (pDb: number) => ({
  total: Number(shellApi().wasm.exports.sqlite3_total_changes64(pDb)),
  schema: Number(shellRows(pDb, "PRAGMA schema_version", [], 1).rows[0][0]),
});

const shellHandleValue = () => ({
  handle: String(shellHandle()),
  filename: dbFilename(sqlite3!),
});

const shellQuery = (
  pDb: number,
  sql: string,
  params: readonly ShellCell[],
  maxRows: number,
): ShellOpValue => {
  const X = shellApi().wasm.exports;
  const before = shellCounters(pDb);
  const { columns, rows, truncated } = shellRows(pDb, sql, params, maxRows);
  const after = shellCounters(pDb);
  return {
    columns,
    rows,
    changes: after.total - before.total,
    schemaChanged: after.schema !== before.schema,
    truncated,
    lastInsertRowid: Number(X.sqlite3_last_insert_rowid(pDb)),
    autocommit: X.sqlite3_get_autocommit(pDb) !== 0,
    totalChanges: after.total,
    schemaVersion: after.schema,
    handle: String(pDb),
  };
};

/**
 * Validates the image on a private in-memory connection (deserialize +
 * quick_check), then copies it into the shell's handle with the backup API:
 * the live connection, its VFS and the handle stay the same, and a bad image
 * never touches it.
 */
const shellImport = (pDb: number, bytes: unknown): ShellOpValue => {
  if (!(bytes instanceof Uint8Array)) throw new Error("import expects bytes");
  const header = new TextDecoder().decode(bytes.subarray(0, 16));
  if (bytes.length < 512 || header !== "SQLite format 3\0") {
    throw new Error("not an SQLite database image (bad header)");
  }
  const { capi, wasm, oo1 } = shellApi();
  const tmp = new oo1.DB(":memory:", "c");
  try {
    const p = wasm.allocFromTypedArray(bytes);
    const rc = capi.sqlite3_deserialize(
      tmp.pointer,
      "main",
      p,
      bytes.byteLength,
      bytes.byteLength,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
    if (rc !== 0) {
      wasm.dealloc(p);
      throw new Error(
        `sqlite3_deserialize failed: ${capi.sqlite3_errmsg(tmp.pointer)}`,
      );
    }
    let check: ShellCell;
    try {
      check = shellRows(tmp.pointer, "PRAGMA quick_check", [], 1).rows[0]?.[0];
    } catch (e) {
      throw new Error(`imported image failed quick_check: ${describe(e)}`);
    }
    if (check !== "ok") {
      throw new Error(`imported image failed quick_check: ${String(check)}`);
    }
    const backup = capi.sqlite3_backup_init(pDb, "main", tmp.pointer, "main");
    if (!backup) throw new Error(`backup failed: ${capi.sqlite3_errmsg(pDb)}`);
    const step = capi.sqlite3_backup_step(backup, -1);
    const finish = capi.sqlite3_backup_finish(backup);
    if (step !== SHELL_SQLITE_DONE || finish !== 0) {
      throw new Error(
        `backup failed: rc=${step === SHELL_SQLITE_DONE ? finish : step}`,
      );
    }
  } finally {
    tmp.close();
  }
  return shellHandleValue();
};

const shellOp = (req: ShellOpRequest) => {
  const operation = req.op === "query" ? "execute" : req.op;
  const reply = (event: ShellOpEvent) =>
    scope.postMessage(event as unknown as WorkerEvent);
  if (phase !== "ready" || !sqlite3) {
    reply({
      family: "shell",
      op: "reply",
      id: req.id,
      ok: false,
      error: dbError(
        operation,
        `engine is ${phase}; shell "${req.op}" rejected`,
      ),
    });
    return;
  }
  try {
    shellEnsureOpen();
    const pDb = shellHandle();
    shellLastHandle = pDb;
    let value: ShellOpValue;
    switch (req.op) {
      case "query":
        value = shellQuery(
          pDb,
          req.sql,
          req.params ?? [],
          req.maxRows ?? SHELL_MAX_ROWS,
        );
        break;
      case "reset":
        shellApi().wasm.exports.fiddle_reset_db();
        shellLastHandle = shellHandle();
        value = shellHandleValue();
        break;
      case "export":
        value = {
          ...shellHandleValue(),
          bytes: shellApi().capi.sqlite3_js_db_export(pDb),
        };
        break;
      case "import":
        value = shellImport(pDb, req.bytes);
        break;
    }
    reply({ family: "shell", op: "reply", id: req.id, ok: true, value });
  } catch (e) {
    reply({
      family: "shell",
      op: "reply",
      id: req.id,
      ok: false,
      error: dbError(
        operation,
        describe(e),
        (e as { name?: string })?.name ?? null,
      ),
    });
  }
};

const shellFamily = (req: ShellRequest) => {
  if (req.op === "submit") {
    shellSubmit(req.text);
    return;
  }
  if (req.op === "interrupt") {
    // Cannot take effect while fiddle_exec runs (the worker is busy); kept
    // for the COOP/COEP progress-handler path (plan.md Q15, deferred).
    if (phase === "ready" && sqlite3) {
      shellApi().wasm.exports.fiddle_interrupt();
    }
    return;
  }
  const extra = req as unknown as ShellOpRequest;
  if (SHELL_OPS.includes(extra.op) && typeof extra.id === "number") {
    shellOp(extra);
    return;
  }
  shellStderr(`unknown shell op "${String((req as { op: unknown }).op)}"`);
};
// ---- end shell family ----

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
      shellFamily(req);
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
