// Minimal typings for the parts of the vendored Fiddle bundle
// (public/vendor/fiddle/fiddle-module.js) that the engine worker touches. The
// bundle is the upstream sqlite3 JS API plus the fiddle_* shell exports; see
// pocs/sqlite-shell/README.md "Exports found" and docs/integrations.md.

export interface FiddleExports {
  fiddle_main(argc: number, argv: number): number;
  fiddle_db_handle(): number;
  fiddle_reset_db(): void;
  fiddle_interrupt(): void;
  sqlite3_complete(pSql: number): number;
  [name: string]: (...args: never[]) => unknown;
}

export interface FiddleWasm {
  readonly exports: FiddleExports;
  readonly ptr: { readonly size: number };
  /** cwrap equivalent: xWrap(name, resultType, argTypes). */
  xWrap(
    name: string,
    result: string | undefined,
    args: readonly string[],
  ): (...args: unknown[]) => unknown;
  /** Allocates a C argv; intentionally leaked because main() keeps it. */
  allocMainArgv(argv: readonly string[]): number;
  cstrToJs(ptr: number): string;
}

export interface FiddleVfs {
  readonly $zName: number;
  dispose(): void;
}

export interface FiddleCapi {
  sqlite3_libversion(): string;
  sqlite3_sourceid(): string;
  sqlite3_shutdown(): number;
  sqlite3_vfs: new (ptr: number) => FiddleVfs;
}

export interface FiddleSqlite3 {
  readonly capi: FiddleCapi;
  readonly wasm: FiddleWasm;
}

/** Emscripten Module overrides accepted by sqlite3InitModule(). */
export interface FiddleModuleConfig {
  print(...parts: unknown[]): void;
  printErr(...parts: unknown[]): void;
  locateFile(path: string): string;
  setStatus(text: string): void;
}

export type Sqlite3InitModule = (
  config: FiddleModuleConfig,
) => Promise<FiddleSqlite3>;

// ---- exec family (D1) ----
// Typings for the parts of the bundled sqlite3 JS API (capi, OO1, SAHPool)
// that the worker's exec family uses on the shell's own sqlite3*.

export interface FiddleD1Exports {
  /** Raw export; capi.sqlite3_bind_text has an upstream bug (plan.md §9). */
  sqlite3_bind_text(
    pStmt: number,
    index: number,
    pText: number,
    nBytes: number,
    destructor: number,
  ): number;
  fiddle_exec(pSql: number): void;
}

export interface FiddleOo1Stmt {
  readonly pointer: number;
  step(): boolean;
  get(index: number): unknown;
  finalize(): void;
}

export interface FiddleOo1ExecOptions {
  sql: string;
  rowMode: "array";
  columnNames?: string[];
  callback?: (row: unknown[]) => boolean | void;
}

export interface FiddleOo1Db {
  readonly pointer: number;
  exec(options: FiddleOo1ExecOptions): unknown;
  selectValue(sql: string): unknown;
  prepare(sql: string): FiddleOo1Stmt;
  close(): void;
}

export interface FiddleOo1 {
  readonly DB: {
    new (filename: string, flags?: string): FiddleOo1Db;
    wrapHandle(pDb: number, takeOwnership?: boolean): FiddleOo1Db;
  };
}

export interface FiddleSahPool {
  readonly vfsName: string;
}

/** sqlite3_update_hook callback: (ctx, op, zDb, zTable, rowid). */
export type FiddleUpdateHook = (
  ctx: number,
  op: number,
  zDb: number,
  zTable: number,
  rowid: bigint,
) => void;

export interface FiddleD1Capi {
  sqlite3_vfs_find(name: string | null): number;
  sqlite3_vfs_register(pVfs: number, makeDefault: number): number;
  sqlite3_update_hook(pDb: number, hook: FiddleUpdateHook, ctx: number): number;
  sqlite3_commit_hook(
    pDb: number,
    hook: (ctx: number) => number,
    ctx: number,
  ): number;
  sqlite3_total_changes64(pDb: number): bigint | number;
  sqlite3_get_autocommit(pDb: number): number;
  sqlite3_js_db_export(pDb: number): Uint8Array;
  sqlite3_deserialize(
    pDb: number,
    schema: string,
    pData: number,
    nData: number,
    nBuffer: number,
    flags: number,
  ): number;
  sqlite3_backup_init(
    pDest: number,
    destName: string,
    pSource: number,
    sourceName: string,
  ): number;
  sqlite3_backup_step(pBackup: number, nPage: number): number;
  sqlite3_backup_finish(pBackup: number): number;
  sqlite3_errmsg(pDb: number): string;
  sqlite3_js_rc_str(rc: number): string;
  readonly SQLITE_DESERIALIZE_FREEONCLOSE: number;
  readonly SQLITE_DESERIALIZE_RESIZEABLE: number;
}

export interface FiddleD1Wasm {
  readonly exports: FiddleExports & FiddleD1Exports;
  allocFromTypedArray(bytes: Uint8Array): number;
  allocCString(text: string): number;
  dealloc(ptr: number): void;
}

export interface FiddleD1Sqlite3 {
  readonly capi: FiddleCapi & FiddleD1Capi;
  readonly wasm: FiddleWasm & FiddleD1Wasm;
  readonly oo1: FiddleOo1;
  installOpfsSAHPoolVfs(
    options?: Record<string, unknown>,
  ): Promise<FiddleSahPool>;
}
// ---- end exec family ----
