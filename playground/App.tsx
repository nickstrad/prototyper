// Initial R0 playground: an application terminal (xterm.js + just-bash +
// Effect example commands) beside the engine worker status. Later slices
// mount the real prototypes and the DatabaseEditor host here.
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { EngineInfo, WorkerEvent } from "../packages/core/types.ts";
import {
  type EngineWorkerClient,
  spawnEngineWorker,
} from "../packages/database/worker-client.ts";
import {
  exposeWorkbenchHooks,
  SqliteWorkbench,
  workbenchPersistenceFromUrl,
} from "../packages/database/sqlite-workbench.tsx"; // D1 workbench
import { SqliteShellWorkbench } from "../packages/database-editor/sqlite-shell-workbench.tsx"; // DB0 editor
import { DuckDbHooks } from "../packages/database/duckdb-hooks.tsx"; // D2 duckdb
import {
  exposeTaskManagerHooks,
  playgroundTaskManagerLayer,
  TaskManagerApp,
} from "../prototypes/task-manager/App.tsx"; // R1 task manager
import { ApiExplorer, exposeApiExplorerHooks } from "./api/ApiExplorer.tsx"; // R3 api explorer
import {
  mergeCommands,
  taskManagerTerminal,
} from "../prototypes/task-manager/commands.ts"; // R2 commands
import { makeTasksRuntime } from "../packages/terminal/examples/tasks.ts";
import { exampleCommands } from "../packages/terminal/examples/tasks-command.ts";
import { createShell } from "../packages/terminal/shell.ts";
import {
  attachShell,
  type TerminalSession,
} from "../packages/terminal/xterm-adapter.ts";

/** Test hooks for Playwright (tests/browser/smoke.spec.ts). */
export interface PlaygroundHooks {
  readonly term: Terminal;
  readonly session: TerminalSession;
  readonly engine: EngineWorkerClient;
  readonly engineEvents: readonly WorkerEvent[];
}

declare global {
  interface Window {
    __playground?: PlaygroundHooks;
  }
}

type EngineState =
  | { phase: "loading" }
  | { phase: "ready"; info: EngineInfo }
  | { phase: "failed"; message: string };

const BANNER = "Prototyper R0 terminal (just-bash + Effect).\n" +
  "Try: hello Alice · tasks create \"Build API\" · tasks list --json | jq '.[].title' · tasks complete 42\n";

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<EngineState>({ phase: "loading" });
  const [shellLines, setShellLines] = useState<readonly string[]>([]);

  useEffect(() => {
    const runtime = makeTasksRuntime();
    const term = new Terminal({ cols: 100, rows: 24, convertEol: false });
    term.open(host.current!);
    // ---- R2 commands ----
    // The real `tasks` and the standard `db` commands replace R0's in-memory
    // example `tasks`; they run on a runtime over the same layer the R1
    // panel uses, so both resolve the workbench's one DatabaseService.
    const r2 = taskManagerTerminal(playgroundTaskManagerLayer);
    const session = attachShell(
      term,
      createShell(mergeCommands(exampleCommands(runtime), r2.commands)),
      { banner: BANNER },
    );
    // ---- end R2 commands ----
    term.focus();

    const client = spawnEngineWorker();
    const engineEvents: WorkerEvent[] = [];
    const unsubscribe = client.subscribe((event) => {
      engineEvents.push(event);
      if (event.family === "shell" && event.op === "output") {
        setShellLines((lines) => [...lines, `[${event.stream}] ${event.text}`]);
      }
    });
    client.ready.then(
      (info) => setEngine({ phase: "ready", info }),
      (error: { message?: string }) =>
        setEngine({
          phase: "failed",
          message: error?.message ?? String(error),
        }),
    );

    globalThis.window.__playground = {
      term,
      session,
      engine: client,
      engineEvents,
    };
    return () => {
      unsubscribe();
      client.terminate();
      session.dispose();
      term.dispose();
      void runtime.dispose();
      void r2.dispose(); // R2 commands
      delete globalThis.window.__playground;
    };
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>Prototyper playground (R0)</h1>
      <section>
        <h2 style={{ fontSize: 16 }}>Application terminal</h2>
        <div ref={host} data-testid="terminal" />
      </section>
      <section>
        <h2 style={{ fontSize: 16 }}>Engine worker (vendored SQLite Fiddle)</h2>
        <p data-testid="engine-status">
          {engine.phase === "loading" && "loading engine worker…"}
          {engine.phase === "failed" && `engine failed: ${engine.message}`}
          {engine.phase === "ready" && (
            `SQLite ${engine.info.libversion} · source ${
              engine.info.sourceId.slice(0, 30)
            } · file ${engine.info.filename || "(not opened yet)"} · vfs ${
              engine.info.vfs ?? "(none)"
            } · prompt "${engine.info.prompt}" · COI ${
              String(
                engine.info.crossOriginIsolated,
              )
            }`
          )}
        </p>
        <pre data-testid="engine-shell-output" style={{ minHeight: "1em" }}>
          {shellLines.join("\n")}
        </pre>
      </section>
      {/* ---- D1 workbench ---- */}
      <SqliteWorkbench
        persistence={workbenchPersistenceFromUrl()}
        onHooks={exposeWorkbenchHooks}
      />
      {/* ---- end D1 workbench ---- */}
      {/* ---- DB0 editor ---- */}
      <SqliteShellWorkbench />
      {/* ---- end DB0 editor ---- */}
      {/* ---- D2 duckdb ---- */}
      <DuckDbHooks />
      {/* ---- end D2 duckdb ---- */}
      {/* ---- R1 task manager ---- */}
      <TaskManagerApp
        layer={playgroundTaskManagerLayer}
        onHooks={exposeTaskManagerHooks}
      />
      {/* ---- end R1 task manager ---- */}
      {/* ---- R3 api explorer ---- */}
      <ApiExplorer
        layer={playgroundTaskManagerLayer}
        onHooks={exposeApiExplorerHooks}
      />
      {/* ---- end R3 api explorer ---- */}
    </main>
  );
}
