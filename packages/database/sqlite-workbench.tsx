// Seeded SQLite workbench panel for the playground: engine status, table list
// and a SQL box over the browser DatabaseService (Fiddle engine worker). It is
// deliberately not a shell (DB0 owns the upstream sqlite3 shell); results are
// rendered from QueryResult cells, refreshed on every change event.
import { useCallback, useEffect, useState } from "react";
import { Effect, Fiber, ManagedRuntime, Stream } from "effect";
import type {
  DatabaseChange,
  DatabaseService,
  Persistence,
  QueryResult,
} from "../core/types.ts";
import {
  browserSqliteLayer,
  type BrowserSqliteOptions,
} from "./sqlite-browser.ts";
import { cellText } from "./sqlite-cells.ts";
import { spawnEngineWorker } from "./worker-client.ts";
import { type ConformanceOutcome, runConformance } from "./conformance.ts";
import { Database } from "./sqlite-service.ts";
import { TASKS_SCHEMA, TASKS_SEED } from "./sqlite-seed.ts";

/** Test hooks the playground exposes as `window.__playground.d1`. */
export interface SqliteWorkbenchHooks {
  readonly service: DatabaseService;
  readonly events: readonly DatabaseChange[];
  /** `service.execute(sql)` as a promise (rejects with the DatabaseError). */
  exec(sql: string): Promise<QueryResult>;
  /** Runs the conformance suite against fresh browser services. */
  conformance(
    options?: { persistence?: Persistence; fresh?: boolean; filter?: string },
  ): Promise<ConformanceOutcome[]>;
  /** Builds a scoped service, runs `sql`, closes it; reports worker teardown. */
  scopedRun(sql: string): Promise<{
    rows: QueryResult["rows"];
    disposes: number;
    closes: number;
    afterClose: string;
  }>;
  /**
   * Shares one engine worker between a service and the upstream shell, feeds
   * `lines` to the shell and reports the service's change events plus what
   * the service then reads with `query`.
   */
  shellBridge(lines: readonly string[], query: string): Promise<{
    events: readonly DatabaseChange[];
    rows: QueryResult["rows"];
    /** Shell stdout/stderr lines seen on the shared worker. */
    output: readonly string[];
  }>;
}

const seeded = { schema: TASKS_SCHEMA, seed: TASKS_SEED };

const getDatabase = Effect.gen(function* () {
  return yield* Database;
});

export const sqliteWorkbenchLayer = (options: BrowserSqliteOptions = {}) =>
  browserSqliteLayer({ ...seeded, ...options });

const conformance: SqliteWorkbenchHooks["conformance"] = (options = {}) => {
  const persistence = options.persistence ?? "memory";
  return runConformance({
    name: `fiddle ${persistence}`,
    expectPersistence: persistence,
    layer: (hooks) =>
      sqliteWorkbenchLayer({
        persistence,
        fresh: options.fresh ?? true,
        ...hooks,
      }),
  }, options.filter);
};

const scopedRun: SqliteWorkbenchHooks["scopedRun"] = async (sql) => {
  let disposes = 0;
  let closes = 0;
  const runtime = ManagedRuntime.make(sqliteWorkbenchLayer({
    persistence: "memory",
    onDispose: () => disposes++,
    onClose: () => closes++,
  }));
  const db = await runtime.runPromise(getDatabase);
  const r = await Effect.runPromise(db.execute(sql));
  await runtime.dispose();
  const afterClose = await Effect.runPromise(
    db.execute("SELECT 1").pipe(
      Effect.match({
        onFailure: (e) => `${e._tag}: ${e.message}`,
        onSuccess: () => "succeeded",
      }),
    ),
  );
  return { rows: r.rows, disposes, closes, afterClose };
};

const shellBridge: SqliteWorkbenchHooks["shellBridge"] = async (
  lines,
  query,
) => {
  const client = spawnEngineWorker({ name: "d1-shell-bridge" });
  const output: string[] = [];
  client.subscribe((e) => {
    if (e.family === "shell" && e.op === "output") output.push(e.text);
  });
  const runtime = ManagedRuntime.make(
    sqliteWorkbenchLayer({ persistence: "memory", client }),
  );
  try {
    const db = await runtime.runPromise(getDatabase);
    const events: DatabaseChange[] = [];
    const fiber = Effect.runFork(
      Stream.runForEach(db.changes, (c) => Effect.sync(() => events.push(c))),
    );
    await new Promise((r) => setTimeout(r, 20)); // let the stream subscribe
    for (const text of lines) {
      client.shell({ family: "shell", op: "submit", text });
    }
    // Shell output is asynchronous; a request on the same worker queues
    // behind every submission, and its reply follows their change events.
    await new Promise((r) => setTimeout(r, 100));
    const result = await Effect.runPromise(db.execute(query));
    await new Promise((r) => setTimeout(r, 20));
    await Effect.runPromise(Fiber.interrupt(fiber));
    return { events, rows: result.rows, output };
  } finally {
    await runtime.dispose();
    client.terminate();
  }
};

type Status =
  | { phase: "loading" }
  | { phase: "ready"; db: DatabaseService }
  | { phase: "failed"; message: string };

const box = {
  border: "1px solid #ccc",
  borderRadius: 4,
  padding: 8,
} as const;

export function SqliteWorkbench(props: {
  readonly persistence?: Persistence;
  readonly onHooks?: (hooks: SqliteWorkbenchHooks) => void;
}) {
  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [tables, setTables] = useState<readonly string[]>([]);
  const [sql, setSql] = useState("SELECT * FROM tasks ORDER BY id");
  const [result, setResult] = useState<QueryResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [eventCount, setEventCount] = useState(0);
  const { persistence, onHooks } = props;

  useEffect(() => {
    const runtime = ManagedRuntime.make(
      sqliteWorkbenchLayer({ persistence: persistence ?? "opfs-sahpool" }),
    );
    const events: DatabaseChange[] = [];
    let fiber: Fiber.Fiber<void> | undefined;
    let live = true;
    runtime.runPromise(getDatabase).then(
      (db) => {
        if (!live) return;
        const refresh = () =>
          Effect.runPromise(db.tables()).then(
            (t) => live && setTables(t),
            () => {},
          );
        fiber = Effect.runFork(
          Stream.runForEach(db.changes, (change) =>
            Effect.sync(() => {
              events.push(change);
              setEventCount(events.length);
              void refresh();
            })),
        );
        void refresh();
        setStatus({ phase: "ready", db });
        onHooks?.({
          service: db,
          events,
          exec: (text) => Effect.runPromise(db.execute(text)),
          conformance,
          scopedRun,
          shellBridge,
        });
      },
      (e: { message?: string }) =>
        live &&
        setStatus({ phase: "failed", message: e?.message ?? String(e) }),
    );
    return () => {
      live = false;
      if (fiber) Effect.runFork(Fiber.interrupt(fiber));
      void runtime.dispose();
    };
  }, [persistence, onHooks]);

  const run = useCallback((text: string) => {
    if (status.phase !== "ready") return;
    setSql(text);
    Effect.runPromise(Effect.result(status.db.execute(text))).then((r) => {
      if (r._tag === "Success") {
        setResult(r.success);
        setError(undefined);
      } else {
        setResult(undefined);
        setError(`${r.failure.operation}: ${r.failure.message}`);
      }
    });
  }, [status]);

  const db = status.phase === "ready" ? status.db : undefined;
  return (
    <section data-testid="d1-workbench" style={{ ...box, marginTop: 16 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>
        SQLite workbench (DatabaseService)
      </h2>
      <p data-testid="d1-status" style={{ margin: "0 0 8px" }}>
        {status.phase === "loading" && "opening database…"}
        {status.phase === "failed" && `database failed: ${status.message}`}
        {db &&
          `SQLite ${db.version} · persistence ${db.persistence.actual}` +
            (db.persistence.reason ? ` (${db.persistence.reason})` : "") +
            ` · requested ${db.persistence.requested} · events ${eventCount}`}
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <nav style={{ minWidth: 140 }}>
          <strong>Tables</strong>
          <ul data-testid="d1-tables" style={{ paddingLeft: 16, margin: 4 }}>
            {tables.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  onClick={() =>
                    run(`SELECT * FROM "${t.replaceAll('"', '""')}" LIMIT 100`)}
                >
                  {t}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div style={{ flex: 1, minWidth: 260 }}>
          <textarea
            data-testid="d1-sql"
            value={sql}
            rows={4}
            style={{ width: "100%", fontFamily: "monospace" }}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run(sql);
            }}
          />
          <button
            type="button"
            data-testid="d1-run"
            disabled={!db}
            onClick={() => run(sql)}
          >
            Run
          </button>
          {error && (
            <pre
              data-testid="d1-error"
              style={{ color: "#b00020" }}
            >{error}</pre>
          )}
          {result && (
            <div data-testid="d1-result" style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", marginTop: 8 }}>
                <thead>
                  <tr>
                    {result.columns.map((c, i) => (
                      <th key={i} style={{ ...box, textAlign: "left" }}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c} style={{ ...box, fontFamily: "monospace" }}>
                          {cellText(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p data-testid="d1-summary">
                {`${result.rows.length} row(s) · changes ${result.changes}` +
                  (result.schemaChanged ? " · schema changed" : "") +
                  (result.truncated ? " · truncated" : "")}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** `?d1-persistence=memory|opfs-sahpool|opfs` (default opfs-sahpool, Q15). */
export const workbenchPersistenceFromUrl = (): Persistence => {
  const value = new URLSearchParams(globalThis.location?.search ?? "").get(
    "d1-persistence",
  );
  return value === "memory" || value === "opfs" ? value : "opfs-sahpool";
};

/**
 * Publishes the hooks as `window.__playground.d1` for Playwright. The
 * playground creates `__playground` in its own effect, which may run after
 * this panel's, so wait for it briefly.
 */
export const exposeWorkbenchHooks = (hooks: SqliteWorkbenchHooks): void => {
  const target = globalThis as { __playground?: Record<string, unknown> };
  let tries = 0;
  const attach = () => {
    if (target.__playground) target.__playground.d1 = hooks;
    else if (tries++ < 100) setTimeout(attach, 20);
  };
  attach();
};
