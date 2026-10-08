// DuckDB engine bootstrap for the DuckDB DatabaseService (D2): one
// `AsyncDuckDB` on one classic Web Worker per service instance, the `eh`
// bundle only, self-hosted json/parquet extensions, `opfs://` persistence with
// a memory fallback that carries a reason (plan.md Q15/Q18,
// pocs/duckdb-shell/README.md).
//
// Assets come from `<base>vendor/duckdb/`, populated by
// `deno run -A scripts/fetch-duckdb-extensions.ts` (sizes and sha256 in
// public/vendor/duckdb/PROVENANCE.md). Nothing is fetched from a CDN:
// `custom_extension_repository` points at the same origin, and the
// `opfs.fileHandling` auto-registration of arbitrary `opfs://` paths found in
// SQL text stays off.
//
// The database path is chosen here and nowhere else (Q12/Q17): after the
// engine's own open, `AsyncDuckDB.open` is replaced by a function that
// rejects, so neither the service nor a shell bound to the same instance can
// reopen it onto another path.
// Local declarations: the package's own types drag @types/node@20 into the
// program (see duckdb-wasm.d.ts).
// @ts-types="./duckdb-wasm.d.ts"
import * as duckdb from "@duckdb/duckdb-wasm";
import type { Persistence } from "../core/types.ts";

export type AsyncDuckDB = duckdb.AsyncDuckDB;
export type AsyncDuckDBConnection = duckdb.AsyncDuckDBConnection;

/** `<base>vendor/duckdb/` under Vite's BASE_URL (or "/" outside Vite). */
export const defaultDuckDbAssetBase = (): string => {
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? "/"}vendor/duckdb/`;
};

/** Engine version inside @duckdb/duckdb-wasm@1.32.0 (extension directory). */
export const DUCKDB_ENGINE = "v1.4.3";

/** Database names map to `opfs://prototyper-<name>.duckdb`; nothing else. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type DuckDbEngineOptions = {
  /** "opfs" (default, Q15) or "memory"; "opfs-sahpool" is SQLite-only. */
  readonly persistence?: Persistence;
  /** Prototype name; letters, digits, `_` and `-` only. Default "prototype". */
  readonly name?: string;
  /** URL prefix ending in "/" holding the eh bundle and extensions. */
  readonly assetBase?: string;
  /** Delete the persisted file before opening (tests, explicit wipe). */
  readonly fresh?: boolean;
};

export type DuckDbEngine = {
  readonly db: AsyncDuckDB;
  readonly worker: Worker;
  /** e.g. "1.4.3" (the engine reports "v1.4.3"). */
  readonly version: string;
  /** ":memory:" or `opfs://prototyper-<name>.duckdb`. */
  readonly path: string;
  readonly persistence: {
    readonly requested: Persistence;
    readonly actual: Persistence;
    readonly reason?: string;
  };
  readonly extensionRepository: string;
  /** Terminates the worker; idempotent. */
  terminate(): Promise<void>;
};

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Removes the OPFS database file and its WAL; missing files are fine. */
const wipeOpfs = async (file: string): Promise<void> => {
  const root = await navigator.storage.getDirectory();
  for (const name of [file, `${file}.wal`]) {
    try {
      await root.removeEntry(name);
    } catch (e) {
      if ((e as { name?: string }).name !== "NotFoundError") throw e;
    }
  }
};

const opfsAvailable = (): boolean =>
  typeof navigator !== "undefined" &&
  typeof navigator.storage?.getDirectory === "function";

/** Opens the `eh` bundle; rejects when the browser cannot run it. */
const instantiate = async (
  base: string,
): Promise<{ db: AsyncDuckDB; worker: Worker }> => {
  const features = await duckdb.getPlatformFeatures();
  if (!features.wasmExceptions) {
    throw new Error(
      "this browser lacks WebAssembly exception handling; only the DuckDB eh bundle is shipped (plan.md Q18)",
    );
  }
  const worker = new Worker(new URL("duckdb-browser-eh.worker.js", base));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  try {
    await db.instantiate(new URL("duckdb-eh.wasm", base).href);
  } catch (e) {
    await db.terminate();
    throw e;
  }
  return { db, worker };
};

/** Absolute URL of the asset base (Worker and the engine need absolute). */
const absolute = (base: string): string =>
  new URL(base, globalThis.location?.href ?? "http://localhost/").href;

/**
 * Starts the engine and opens the one database this instance may ever use.
 * OPFS failures (no OPFS, file held by another tab) fall back to memory and
 * say why in `persistence.reason`.
 */
export const startDuckDb = async (
  options: DuckDbEngineOptions = {},
): Promise<DuckDbEngine> => {
  const requested = options.persistence ?? "opfs";
  const name = options.name ?? "prototype";
  if (!NAME.test(name)) {
    throw new Error(
      `invalid database name ${
        JSON.stringify(name)
      }: use letters, digits, _ and -`,
    );
  }
  const base = absolute(options.assetBase ?? defaultDuckDbAssetBase());
  let { db, worker } = await instantiate(base);
  try {
    let path = ":memory:";
    let actual: Persistence = "memory";
    let reason: string | undefined;
    const config = {
      // Never auto-register `opfs://` paths found in SQL text (Q12/Q17).
      opfs: { fileHandling: "manual" as const },
      query: { castBigIntToDouble: false, castDecimalToDouble: false },
    };
    if (requested === "opfs") {
      const file = `prototyper-${name}.duckdb`;
      if (!opfsAvailable()) {
        reason = "OPFS is not available in this browser; using memory";
      } else {
        try {
          if (options.fresh) await wipeOpfs(file);
          await db.open({
            ...config,
            path: `opfs://${file}`,
            accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
          });
          path = `opfs://${file}`;
          actual = "opfs";
        } catch (e) {
          const text = message(e);
          reason = /Access Handle|NoModificationAllowed|createSyncAccessHandle/i
              .test(text)
            ? `open in another tab (${text}); using memory`
            : `OPFS open failed (${text}); using memory`;
          // A failed open can leave the instance half-initialized: restart.
          await db.terminate();
          ({ db, worker } = await instantiate(base));
        }
      }
    } else if (requested !== "memory") {
      reason = `${requested} is a SQLite mode; DuckDB supports memory or opfs`;
    }
    if (actual === "memory") await db.open({ ...config, path: ":memory:" });

    const extensionRepository = `${base}extensions`;
    const conn = await db.connect();
    try {
      // Global settings: every connection, the shell's included, inherits
      // them. Autoloaded json/parquet come from this origin only.
      await conn.query(
        `SET custom_extension_repository = '${
          extensionRepository.replaceAll("'", "''")
        }'`,
      );
      await conn.query("SET autoinstall_known_extensions = true");
      await conn.query("SET autoload_known_extensions = true");
      // Buffer files are replaced in place (export/import images reuse
      // names); a cached copy of an old file must never be read.
      await conn.query("SET enable_external_file_cache = false");
    } finally {
      await conn.close();
    }
    const version = (await db.getVersion()).replace(/^v/, "");
    blockOpen(db);

    let terminated: Promise<void> | undefined;
    const engine: DuckDbEngine = {
      db,
      worker,
      version,
      path,
      persistence: reason === undefined
        ? { requested, actual }
        : { requested, actual, reason },
      extensionRepository,
      terminate: () => (terminated ??= db.terminate()),
    };
    return engine;
  } catch (e) {
    await db.terminate();
    throw e;
  }
};

/** Message of the error every later `AsyncDuckDB.open` call rejects with. */
export const OPEN_BLOCKED =
  "AsyncDuckDB.open is blocked: the database path is fixed by the DatabaseService (plan.md Q12/Q17/Q18)";

/** Replaces `db.open` so nothing can reopen the instance onto another path. */
const blockOpen = (db: AsyncDuckDB): void => {
  Object.defineProperty(db, "open", {
    configurable: true,
    value: () => Promise.reject(new Error(OPEN_BLOCKED)),
  });
};
