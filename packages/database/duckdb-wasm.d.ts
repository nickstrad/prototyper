// Type surface of @duckdb/duckdb-wasm@1.32.0 that the DuckDB service uses,
// declared locally and bound with `// @ts-types` in duckdb-engine.ts.
//
// Why: the package's own declarations import apache-arrow@17, whose
// `/// <reference types="node" />` resolves to @types/node@20 (installed with
// apache-arrow) and replaces Deno's built-in Node types for the whole
// program, so `deno check` then fails on `node:sqlite` (native-sqlite.ts,
// D1). With these declarations the DuckDB modules add no Node types. (Vite's
// own `reference types="node"` in vite.config.ts now hits the same
// @types/node@20; that is reported to main, not fixed here.) Signatures are
// copied from node_modules/@duckdb/duckdb-wasm/dist/types/src/parallel/*.d.ts;
// the Arrow table is narrowed to what duckdb-cells.ts and the service read.

/** The parts of an apache-arrow `Table` the service reads. */
export interface ArrowTable {
  readonly numRows: number;
  readonly schema: {
    readonly fields: readonly {
      readonly name: string;
      readonly type: unknown;
    }[];
  };
  readonly batches: readonly {
    readonly numRows: number;
    readonly data: { readonly children: readonly unknown[] };
  }[];
  getChildAt(index: number): { get(index: number): unknown } | null;
  toArray(): { toJSON(): Record<string, unknown> }[];
}

export interface WebFile {
  readonly fileName: string;
  readonly fileSize?: number;
}

export interface ScriptTokens {
  offsets: number[];
  types: number[];
}

export declare enum DuckDBAccessMode {
  UNDEFINED = 0,
  AUTOMATIC = 1,
  READ_ONLY = 2,
  READ_WRITE = 3,
}

export interface DuckDBConfig {
  path?: string;
  accessMode?: DuckDBAccessMode;
  query?: {
    castBigIntToDouble?: boolean;
    castTimestampToDate?: boolean;
    castDurationToTime64?: boolean;
    castDecimalToDouble?: boolean;
  };
  opfs?: { fileHandling?: "auto" | "manual" };
}

export interface Logger {
  log(entry: unknown): void;
}

export declare class VoidLogger implements Logger {
  log(entry: unknown): void;
}

export interface PlatformFeatures {
  bigInt64Array: boolean;
  crossOriginIsolated: boolean;
  wasmExceptions: boolean;
  wasmSIMD: boolean;
  wasmBulkMemory: boolean;
  wasmThreads: boolean;
}

export declare function getPlatformFeatures(): Promise<PlatformFeatures>;

export declare class AsyncDuckDBConnection {
  close(): Promise<void>;
  query(text: string): Promise<ArrowTable>;
}

export declare class AsyncDuckDB {
  constructor(logger: Logger, worker?: Worker | null);
  terminate(): Promise<void>;
  isDetached(): boolean;
  instantiate(
    mainModuleURL: string,
    pthreadWorkerURL?: string | null,
  ): Promise<null>;
  getVersion(): Promise<string>;
  open(config: DuckDBConfig): Promise<void>;
  tokenize(text: string): Promise<ScriptTokens>;
  connect(): Promise<AsyncDuckDBConnection>;
  dropFiles(names?: string[]): Promise<null>;
  globFiles(path: string): Promise<WebFile[]>;
  registerFileBuffer(name: string, buffer: Uint8Array): Promise<void>;
  copyFileToBuffer(name: string): Promise<Uint8Array>;
}
