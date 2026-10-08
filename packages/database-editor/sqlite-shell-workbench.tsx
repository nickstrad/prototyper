// Playground workbench for DB0: spawns one engine worker, seeds the prototype
// database through the DB0 service adapter, mounts the common DatabaseEditor
// host with the upstream sqlite3 shell binding, and exposes test hooks on
// `window.__db0`. A "Database view" toggle unmounts and remounts the host
// without restarting the engine, the way a prototype's tabs would.
import { useEffect, useState } from "react";
import { Effect, Fiber, Scope, Stream } from "effect";
import {
  type DatabaseChange,
  encodeCell,
  type EncodedCell,
} from "../core/types.ts";
import type { EngineWorkerClient } from "../database/worker-client.ts";
import type { SqliteShellService } from "../database/sqlite-shell-service.ts";
import { DatabaseEditor } from "./DatabaseEditor.tsx";
import { openScope, sqliteShellRuntime } from "./sqlite-shell.ts";
import type { EngineInfo, MountedShellBinding } from "./types.ts";

/** Deterministic seed for the playground prototype. */
export const PLAYGROUND_SEED = `
CREATE TABLE tasks(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT INTO tasks(title, done, created_at) VALUES
  ('Build API', 0, '2026-10-08T00:00:00Z'),
  ('Write tests', 1, '2026-10-08T00:01:00Z'),
  ('Ship v1', 0, '2026-10-08T00:02:00Z');
CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT, payload BLOB, big INTEGER);
INSERT INTO notes(body, payload, big) VALUES ('semi;colon', x'00ff10', 9007199254740993);
INSERT INTO notes(body, payload, big) VALUES (NULL, NULL, NULL);
`.trim();

/** JSON-safe QueryResult for page.evaluate (bigint/blob via encodeCell). */
export interface EncodedQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly EncodedCell[])[];
  readonly changes: number;
  readonly schemaChanged: boolean;
  readonly truncated: boolean;
}

/** Test hooks for Playwright (tests/database-editor/*.spec.ts). */
export interface Db0Hooks {
  readonly client: EngineWorkerClient;
  readonly info: EngineInfo;
  readonly service: SqliteShellService;
  readonly binding: MountedShellBinding;
  readonly seed: string;
  /** Change events seen so far, in order. */
  readonly changes: readonly DatabaseChange[];
  /** Promise forms of the Effect APIs, for page.evaluate. */
  submit(line: string): Promise<void>;
  execute(sql: string, maxRows?: number): Promise<EncodedQueryResult>;
  tables(): Promise<readonly string[]>;
  reset(): Promise<void>;
  exportBytes(): Promise<Uint8Array>;
  importBytes(bytes: Uint8Array): Promise<void>;
  /** Closes the runtime scope: terminal, listeners and worker go away. */
  dispose(): Promise<void>;
}

declare global {
  interface Window {
    __db0?: Db0Hooks;
  }
}

type State =
  | { phase: "loading" }
  | { phase: "ready"; hooks: Db0Hooks }
  | { phase: "disposed" }
  | { phase: "failed"; message: string };

export function SqliteShellWorkbench(
  { seed = PLAYGROUND_SEED }: { seed?: string },
) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const { scope, close } = openScope();
    let closed = false;
    let collector: Fiber.Fiber<void> | undefined;
    const dispose = () => {
      if (closed) return Promise.resolve();
      closed = true;
      setState({ phase: "disposed" });
      if (collector) Effect.runFork(Fiber.interrupt(collector));
      return close();
    };
    Effect.runPromise(
      Scope.provide(scope)(
        sqliteShellRuntime({ seed }).pipe(
          Effect.map(({ client, info, service, binding }) => {
            const changes: DatabaseChange[] = [];
            collector = Effect.runFork(
              Stream.runForEach((change: DatabaseChange) =>
                Effect.sync(() => {
                  changes.push(change);
                })
              )(service.changes),
            );
            const hooks: Db0Hooks = {
              client,
              info,
              service,
              binding,
              seed,
              changes,
              submit: (line) => Effect.runPromise(binding.submit(line)),
              execute: (sql, maxRows) =>
                Effect.runPromise(service.execute(sql, { maxRows })).then((
                  r,
                ) => ({
                  ...r,
                  rows: r.rows.map((row) => row.map(encodeCell)),
                })),
              tables: () => Effect.runPromise(service.tables()),
              reset: () => Effect.runPromise(service.reset()),
              exportBytes: () => Effect.runPromise(service.exportBytes()),
              importBytes: (bytes) =>
                Effect.runPromise(service.importBytes(bytes)),
              dispose,
            };
            globalThis.window.__db0 = hooks;
            setState({ phase: "ready", hooks });
          }),
          Effect.catch((e) =>
            Effect.sync(() =>
              setState({
                phase: "failed",
                message: `${e._tag}/${e.operation}: ${e.message}`,
              })
            )
          ),
        ),
      ),
    ).catch((e: unknown) => setState({ phase: "failed", message: String(e) }))
      .finally(() => {
        if (closed) void close();
      });
    return () => {
      if (globalThis.window.__db0) delete globalThis.window.__db0;
      void dispose();
    };
  }, [seed]);

  return (
    <section style={{ fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ fontSize: 16 }}>
        Database editor (DB0: upstream sqlite3 shell on the live database){" "}
        <button
          type="button"
          data-testid="db0-toggle"
          onClick={() => setVisible((v) => !v)}
          disabled={state.phase !== "ready"}
        >
          {visible ? "Hide database view" : "Show database view"}
        </button>
      </h2>
      <p data-testid="db0-status" style={{ fontSize: 12, margin: "4px 0" }}>
        {state.phase === "loading" && "starting engine worker…"}
        {state.phase === "failed" && `editor failed: ${state.message}`}
        {state.phase === "disposed" && "editor disposed (worker terminated)"}
        {state.phase === "ready" &&
          `engine ready · SQLite ${state.hooks.info.libversion} · COI ${
            String(state.hooks.info.crossOriginIsolated)
          }`}
      </p>
      {state.phase === "ready" && visible && (
        <DatabaseEditor
          binding={state.hooks.binding}
          title="Prototype database"
        />
      )}
    </section>
  );
}
