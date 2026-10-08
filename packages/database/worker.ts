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

// ---- exec family (stub; D1 implements) ------------------------------------

const execStub = (req: Extract<WorkerRequest, { family: "exec" }>) => {
  const operation = "op" in req ? req.op : "execute";
  const message = phase === "ready"
    ? `exec family is not implemented in R0 (operation "${operation}"); D1 implements it`
    : `engine is ${phase}; exec "${operation}" rejected`;
  post({
    family: "exec",
    id: req.id,
    ok: false,
    error: dbError(operation, message),
  });
};

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
      execStub(req);
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
