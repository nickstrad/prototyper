// One prototype instance on the playground (R4, main-owned): the application
// terminal (R0 host + R2 commands), the R0 engine status demo, the D1
// workbench that owns the prototype engine, R1's task manager, R3's API
// explorer, the DB0 own-engine editor workbench (kept for DB0's tests), the
// D2 hooks, DB1's DuckDB shell workbench, and the R4 shared-engine editor.
// The App remounts this whole subtree to close/reopen the instance, so every
// runtime, worker and subscription is released and re-acquired together.
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { EngineInfo, WorkerEvent } from "../../packages/core/types.ts";
import {
  type EngineWorkerClient,
  spawnEngineWorker,
} from "../../packages/database/worker-client.ts";
import {
  exposeWorkbenchHooks,
  SqliteWorkbench,
  type SqliteWorkbenchHooks,
  workbenchPersistenceFromUrl,
} from "../../packages/database/sqlite-workbench.tsx"; // D1 workbench
import { SqliteShellWorkbench } from "../../packages/database-editor/sqlite-shell-workbench.tsx"; // DB0 editor
import { DuckDbHooks } from "../../packages/database/duckdb-hooks.tsx"; // D2 duckdb
import { DuckDbShellWorkbench } from "../../packages/database-editor/duckdb-shell.ts"; // DB1 duckdb shell
import {
  exposeTaskManagerHooks,
  playgroundTaskManagerLayer,
  TaskManagerApp,
} from "../../prototypes/task-manager/App.tsx"; // R1 task manager
import { ApiExplorer, exposeApiExplorerHooks } from "../api/ApiExplorer.tsx"; // R3 api explorer
import { EventAnalyticsWorkbench } from "../../prototypes/event-analytics/App.tsx"; // R6 event analytics
import {
  mergeCommands,
  taskManagerTerminal,
} from "../../prototypes/task-manager/commands.ts"; // R2 commands
import { makeTasksRuntime } from "../../packages/terminal/examples/tasks.ts";
import { exampleCommands } from "../../packages/terminal/examples/tasks-command.ts";
import { createShell } from "../../packages/terminal/shell.ts";
import {
  attachShell,
  type TerminalSession,
} from "../../packages/terminal/xterm-adapter.ts";
import { SharedEditor, type SharedEditorHooks } from "./SharedEditor.tsx";

/** Instance-scoped test hooks published as `window.__playground.r4`. */
export interface R4Hooks {
  readonly generation: number;
  /** The shared-engine editor, once bound. */
  editor(): SharedEditorHooks | undefined;
  tasksPanelVisible(): boolean;
  toggleTasksPanel(): void;
}

/** Test hooks for Playwright (tests/browser/smoke.spec.ts and later slices). */
export interface PlaygroundHooks {
  readonly term: Terminal;
  readonly session: TerminalSession;
  readonly engine: EngineWorkerClient;
  readonly engineEvents: readonly WorkerEvent[];
  r4?: R4Hooks;
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
  "Try: hello Alice · tasks create \"Build API\" · tasks list --json | jq '.[].title' · tasks complete 42 · db tables\n";

export function PlaygroundInstance({ generation }: { generation: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<EngineState>({ phase: "loading" });
  const [shellLines, setShellLines] = useState<readonly string[]>([]);
  const [d1, setD1] = useState<SqliteWorkbenchHooks>();
  const [showTasks, setShowTasks] = useState(true);
  const showTasksRef = useRef(true);
  showTasksRef.current = showTasks;
  const editorRef = useRef<SharedEditorHooks | undefined>(undefined);

  const onWorkbenchHooks = useCallback((hooks: SqliteWorkbenchHooks) => {
    exposeWorkbenchHooks(hooks);
    setD1(hooks);
  }, []);
  const onEditorHooks = useCallback((hooks: SharedEditorHooks | undefined) => {
    editorRef.current = hooks;
  }, []);

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
      r4: {
        generation,
        editor: () => editorRef.current,
        tasksPanelVisible: () => showTasksRef.current,
        toggleTasksPanel: () => setShowTasks((v) => !v),
      },
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
  }, [generation]);

  return (
    <>
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
        onHooks={onWorkbenchHooks}
      />
      {/* ---- end D1 workbench ---- */}
      {/* ---- DB0 editor ---- */}
      <SqliteShellWorkbench />
      {/* ---- end DB0 editor ---- */}
      {/* ---- D2 duckdb ---- */}
      <DuckDbHooks />
      {/* ---- end D2 duckdb ---- */}
      {/* ---- DB1 duckdb shell ---- */}
      <DuckDbShellWorkbench />
      {/* ---- end DB1 duckdb shell ---- */}
      {/* ---- R6 event analytics ---- */}
      <EventAnalyticsWorkbench />
      {/* ---- end R6 event analytics ---- */}
      {/* ---- R4 shared-engine editor ---- */}
      <SharedEditor d1={d1} onHooks={onEditorHooks} />
      {/* ---- end R4 shared-engine editor ---- */}
      {/* ---- R1 task manager ---- */}
      <p style={{ marginTop: 16 }}>
        <button
          type="button"
          data-testid="r4-tasks-toggle"
          onClick={() => setShowTasks((v) => !v)}
        >
          {showTasks ? "Hide task manager" : "Show task manager"}
        </button>
      </p>
      {showTasks && (
        <TaskManagerApp
          layer={playgroundTaskManagerLayer}
          onHooks={exposeTaskManagerHooks}
        />
      )}
      {/* ---- end R1 task manager ---- */}
      {/* ---- R3 api explorer ---- */}
      <ApiExplorer
        layer={playgroundTaskManagerLayer}
        onHooks={exposeApiExplorerHooks}
      />
      {/* ---- end R3 api explorer ---- */}
    </>
  );
}
