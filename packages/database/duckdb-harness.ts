// Browser harness for the DuckDB DatabaseService (D2), loaded lazily through
// duckdb-hooks.tsx (`window.__playground.d2.load()`). Playwright drives it
// with page.evaluate(); results cross the boundary as JSON (encodeResult).
import { Effect, ManagedRuntime, Stream } from "effect";
import type {
  DatabaseChange,
  DatabaseService,
  Persistence,
} from "../core/types.ts";
import { type ConformanceOutcome, runConformance } from "./conformance.ts";
import { type EncodedQueryResult, encodeResult } from "./sqlite-cells.ts";
import { Database } from "./sqlite-service.ts";
import { runDuckDbConformance } from "./duckdb-conformance.ts";
import { DUCKDB_TASKS_SCHEMA, DUCKDB_TASKS_SEED } from "./duckdb-seed.ts";
import {
  duckDbHandle,
  type DuckDbServiceOptions,
  layer,
  packExport,
  unpackExport,
} from "./duckdb-service.ts";

const seeded = { schema: DUCKDB_TASKS_SCHEMA, seed: DUCKDB_TASKS_SEED };

const getDatabase = Effect.gen(function* () {
  return yield* Database;
});

export const tasksLayer = (
  options: Partial<DuckDbServiceOptions> = {},
) => layer({ ...seeded, ...options });

type SuiteOptions = {
  readonly persistence?: Persistence;
  readonly filter?: string;
};

/** The DuckDB-dialect conformance suite on fresh services. */
export const conformance = (
  options: SuiteOptions = {},
): Promise<ConformanceOutcome[]> => {
  const persistence = options.persistence ?? "memory";
  return runDuckDbConformance({
    name: `duckdb ${persistence}`,
    expectPersistence: persistence,
    layer: (hooks) =>
      tasksLayer({
        persistence,
        name: "conformance",
        fresh: true,
        ...hooks,
      }),
  }, options.filter);
};

/** D1's SQLite suite (conformance.ts), unchanged, against DuckDB. */
export const d1Conformance = (
  options: SuiteOptions = {},
): Promise<ConformanceOutcome[]> => {
  const persistence = options.persistence ?? "memory";
  return runConformance({
    name: `duckdb ${persistence} (D1 suite unchanged)`,
    expectPersistence: persistence,
    layer: (hooks) =>
      tasksLayer({
        persistence,
        name: "conformance",
        fresh: true,
        ...hooks,
      }),
  }, options.filter);
};

/** Builds a scoped service, runs `sql`, closes it; reports teardown. */
export const scopedRun = async (sql: string) => {
  let disposes = 0;
  let closes = 0;
  const runtime = ManagedRuntime.make(tasksLayer({
    persistence: "memory",
    onClose: () => closes++,
    onDispose: () => disposes++,
  }));
  const db = await runtime.runPromise(getDatabase);
  const result = await runtime.runPromise(db.execute(sql));
  const worker = duckDbHandle(db)!.db;
  await runtime.dispose();
  const afterClose = await Effect.runPromise(
    Effect.flip(db.execute("SELECT 1")).pipe(
      Effect.map((e) => `${e._tag}: ${e.message}`),
    ),
  );
  // After terminate() the AsyncDuckDB has no worker left.
  return {
    rows: encodeResult(result).rows,
    disposes,
    closes,
    afterClose,
    detached: worker.isDetached(),
  };
};

/** Acquires and releases `n` services in a row (leak checks). */
export const cycles = async (n: number) => {
  const versions: string[] = [];
  for (let k = 0; k < n; k++) {
    const runtime = ManagedRuntime.make(tasksLayer({ persistence: "memory" }));
    const db = await runtime.runPromise(getDatabase);
    const r = await runtime.runPromise(
      db.execute("SELECT count(*) FROM tasks"),
    );
    versions.push(`${db.version}:${String(r.rows[0][0])}`);
    await runtime.dispose();
  }
  return versions;
};

// ---- one long-lived service for page-level tests ----------------------------

let failCheckpoints = 0;

let live:
  | {
    runtime: ManagedRuntime.ManagedRuntime<Database, unknown>;
    db: DatabaseService;
    events: DatabaseChange[];
  }
  | undefined;

export type OpenInfo = {
  readonly engine: string;
  readonly version: string;
  readonly persistence: DatabaseService["persistence"];
  readonly capabilities: DatabaseService["capabilities"];
  readonly path: string;
};

/** Opens (or replaces) the page's service; `fresh` wipes its OPFS file. */
export const open = async (
  options: Partial<DuckDbServiceOptions> = {},
): Promise<OpenInfo> => {
  await close();
  const runtime = ManagedRuntime.make(tasksLayer({
    name: "page",
    onCheckpoint: () => {
      if (failCheckpoints > 0) {
        failCheckpoints--;
        throw new Error("injected CHECKPOINT I/O failure");
      }
    },
    ...options,
  }));
  const db = await runtime.runPromise(getDatabase);
  const events: DatabaseChange[] = [];
  void runtime.runFork(
    Stream.runForEach(db.changes, (e) => Effect.sync(() => events.push(e))),
  );
  live = { runtime, db, events };
  return {
    engine: db.engine,
    version: db.version,
    persistence: db.persistence,
    capabilities: db.capabilities,
    path: duckDbHandle(db)!.path,
  };
};

const current = () => {
  if (!live) throw new Error("call open() first");
  return live;
};

/** `execute(sql)` on the page's service; errors come back as text. */
export const exec = async (
  sql: string,
): Promise<
  { ok: true; result: EncodedQueryResult } | { ok: false; error: string }
> => {
  return await Effect.runPromise(
    current().db.execute(sql).pipe(
      Effect.match({
        onSuccess: (r) => ({ ok: true as const, result: encodeResult(r) }),
        onFailure: (e) => ({
          ok: false as const,
          error: `${e._tag}(${e.operation}): ${e.message}`,
        }),
      }),
    ),
  );
};

export const events = (): readonly DatabaseChange[] => [...current().events];

/** Closes the page's service (terminates its worker). */
export const close = async (): Promise<void> => {
  const was = live;
  live = undefined;
  if (was) await was.runtime.dispose();
};

/** Tries to reopen the page's engine elsewhere; returns the rejection. */
export const openBlocked = async (): Promise<string> => {
  try {
    await duckDbHandle(current().db)!.db.open({ path: "opfs://other.duckdb" });
    return "open succeeded";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

/**
 * Runs `appSql` through the page's service while another connection on the
 * same engine (as the shell would) holds an open transaction that ran
 * `otherSql`; then commits it.
 */
export const withOtherTransaction = async (
  otherSql: string,
  appSql: string,
) => {
  const conn = await duckDbHandle(current().db)!.db.connect();
  try {
    await conn.query("BEGIN TRANSACTION");
    await conn.query(otherSql);
    const app = await exec(appSql);
    await conn.query("COMMIT");
    return app;
  } finally {
    await conn.close();
  }
};

/** Makes the page service's next `n` CHECKPOINTs fail (test seam). */
export const injectCheckpointFailures = (n: number): void => {
  failCheckpoints = n;
};

let image: Uint8Array | undefined;

/** `exportBytes()` of the page's service, kept for importImage(). */
export const exportImage = async (): Promise<number> => {
  image = await Effect.runPromise(current().db.exportBytes());
  return image.length;
};

/**
 * Imports the kept image, optionally with `append` added to one of its SQL
 * files (a crafted image), and reports the outcome plus the engine state an
 * image must not be able to change.
 */
export const importImage = async (
  tamper?: { file: "schema.sql" | "load.sql"; append: string },
) => {
  if (!image) throw new Error("call exportImage() first");
  let bytes = image;
  if (tamper) {
    const { manifest, files } = unpackExport(image);
    const k = manifest.files.findIndex((f) => f.name === tamper.file);
    const extra = new TextEncoder().encode(tamper.append);
    const changed = new Uint8Array(files[k].length + extra.length);
    changed.set(files[k]);
    changed.set(extra, files[k].length);
    files[k] = changed;
    bytes = packExport({
      ...manifest,
      files: manifest.files.map((f, i) => ({ ...f, size: files[i].length })),
    }, files);
  }
  const outcome = await Effect.runPromise(
    current().db.importBytes(bytes).pipe(
      Effect.match({
        onSuccess: () => "imported",
        onFailure: (e) => `${e._tag}(${e.operation}): ${e.message}`,
      }),
    ),
  );
  return {
    outcome,
    state: await exec(`SELECT
      (SELECT count(*) FROM duckdb_databases() WHERE NOT internal) AS databases,
      current_setting('custom_extension_repository') AS repo,
      current_setting('enable_external_file_cache') AS file_cache,
      (SELECT count(*) FROM tasks) AS tasks`),
  };
};
