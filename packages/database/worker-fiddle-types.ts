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
