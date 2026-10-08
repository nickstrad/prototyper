// Task manager React UI (project.md §11): list, create, complete/reopen,
// rename and delete tasks, plus reset to the seed. Every operation goes
// through the application core; the list is never refreshed by the action
// that changed it. It re-renders only from watchTasks(), i.e. from the
// DatabaseService `changes` stream of the service it is given, so any write
// made through that same service (another panel, a future CLI or API adapter)
// appears the same way as the UI's own. Writes made on a different engine
// (today: the DB0 sqlite3 shell panel, which runs its own worker) do not.
import { useCallback, useEffect, useRef, useState } from "react";
import { Effect, Fiber, type Layer, ManagedRuntime } from "effect";
import type {
  DatabaseChange,
  DatabaseService,
  Persistence,
} from "../../packages/core/types.ts";
import { browserSqliteBackend } from "../../packages/database/sqlite-browser.ts";
import {
  Database,
  type DatabaseError as SqliteDatabaseError,
} from "../../packages/database/sqlite-service.ts";
import {
  type DatabaseError,
  describeTaskError,
  type Task,
  TaskApplication,
  type TaskApplicationShape,
  type TaskClock,
  type TaskError,
  taskManagerLayer,
  taskManagerLayerFromLookup,
  watchTasks,
} from "./application.ts";

export type TaskManagerLayer = Layer.Layer<
  TaskApplication | Database | TaskClock,
  SqliteDatabaseError | DatabaseError
>;

/** Outcome of a hook call: the value, or the expected failure's tag. */
export type HookResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
    readonly ok: false;
    readonly tag: TaskError["_tag"];
    readonly message: string;
  };

/** Test hooks the playground exposes as `window.__playground.r1`. */
export interface TaskManagerHooks {
  readonly service: DatabaseService;
  readonly app: TaskApplicationShape;
  /** Reloads so far (1 = initial load); grows only on change events. */
  loads(): number;
  run<A>(
    f: (app: TaskApplicationShape) => Effect.Effect<A, TaskError>,
  ): Promise<HookResult<A>>;
  /**
   * A write that bypasses the application: `service.execute(sql,
   * {source: "shell"})` on the same DatabaseService. It stands in for a
   * shell sharing this service; it is not the DB0 shell panel.
   */
  externalWrite(sql: string): Promise<void>;
}

/** The prototype on its own Fiddle engine worker (scoped to the component). */
export const browserTaskManagerLayer = (
  persistence: Persistence = "memory",
): TaskManagerLayer =>
  taskManagerLayer({ backend: browserSqliteBackend({ persistence }) });

/** How long the playground waits for D1's workbench service. */
export const SHARED_SERVICE_TIMEOUT_MS = 30_000;

/**
 * The playground's interim layer: the task manager runs on the SQLite
 * workbench's database, read from the test-hook global
 * `window.__playground.d1.service` (one engine for both panels). If no
 * workbench publishes a service within SHARED_SERVICE_TIMEOUT_MS the panel
 * fails visibly ("no shared database service on this page"); it never starts
 * a second engine. Main replaces this with the page's single engine through
 * the `layer` prop when the playground collapses to one engine (Q2):
 * `layer={() => taskManagerLayerFromService(pageEngine)}`.
 */
export const playgroundTaskManagerLayer = (): TaskManagerLayer =>
  taskManagerLayerFromLookup(
    () =>
      (globalThis as {
        __playground?: { d1?: { service?: DatabaseService } };
      }).__playground?.d1?.service,
    {
      what: "window.__playground.d1.service (SQLite workbench)",
      timeoutMs: SHARED_SERVICE_TIMEOUT_MS,
    },
  );

const getBoth = Effect.gen(function* () {
  return { app: yield* TaskApplication, db: yield* Database };
});

const settle = <A,>(
  effect: Effect.Effect<A, TaskError>,
): Promise<HookResult<A>> =>
  Effect.runPromise(Effect.result(effect)).then((r) =>
    r._tag === "Success" ? { ok: true, value: r.success } : {
      ok: false,
      tag: r.failure._tag,
      message: describeTaskError(r.failure),
    }
  );

const describeChange = (c: DatabaseChange): string =>
  c.kind === "write"
    ? `write from ${c.source} (${c.changes} row${c.changes === 1 ? "" : "s"}${
      c.schemaChanged ? ", schema" : ""
    })`
    : `${c.kind} by ${c.source}`;

type Status =
  | { phase: "loading" }
  | { phase: "ready"; app: TaskApplicationShape; db: DatabaseService }
  | { phase: "failed"; message: string };

const box = {
  border: "1px solid #ccc",
  borderRadius: 4,
  padding: 8,
} as const;

/**
 * `layer` and `onHooks` must be referentially stable (module-level functions
 * or memoized): a new identity disposes the runtime and builds a new one.
 */
export function TaskManagerApp(props: {
  /**
   * Builds the runtime's layer: the explicit injection point for the
   * database. Use taskManagerLayerFromService(service) for a shared engine,
   * browserTaskManagerLayer() for a standalone one.
   */
  readonly layer: () => TaskManagerLayer;
  readonly onHooks?: (hooks: TaskManagerHooks) => void;
}) {
  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [loads, setLoads] = useState(0);
  const [lastChange, setLastChange] = useState<string>("none yet");
  const [title, setTitle] = useState("");
  /** "load": the list could not be read; cleared by the next good load. */
  const [message, setMessage] = useState<
    { text: string; from: "load" | "action" } | undefined
  >();
  const [editing, setEditing] = useState<
    { id: number; title: string } | undefined
  >();
  const { layer, onHooks } = props;
  const loadCount = useRef(0);

  useEffect(() => {
    const runtime = ManagedRuntime.make(layer());
    let live = true;
    let fiber: Fiber.Fiber<never, unknown> | undefined;
    runtime.runPromise(getBoth).then(
      ({ app, db }) => {
        if (!live) return;
        fiber = runtime.runFork(watchTasks(
          (snapshot) => {
            if (!live) return;
            loadCount.current = snapshot.load;
            setTasks(snapshot.tasks);
            setLoads(snapshot.load);
            setMessage((m) => m?.from === "load" ? undefined : m);
            const last = snapshot.changes.at(-1);
            if (last) {
              setLastChange(
                describeChange(last) +
                  (snapshot.changes.length > 1
                    ? ` (+${snapshot.changes.length - 1} coalesced)`
                    : ""),
              );
            }
          },
          (e) =>
            live && setMessage({ text: describeTaskError(e), from: "load" }),
        ));
        setStatus({ phase: "ready", app, db });
        onHooks?.({
          service: db,
          app,
          loads: () => loadCount.current,
          run: (f) => settle(f(app)),
          externalWrite: (sql) =>
            Effect.runPromise(db.execute(sql, { source: "shell" })).then(
              () => {},
            ),
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
  }, [layer, onHooks]);

  const app = status.phase === "ready" ? status.app : undefined;

  /** Runs an operation; the list updates through the change stream. */
  const act = useCallback(
    <A,>(
      f: (app: TaskApplicationShape) => Effect.Effect<A, TaskError>,
      onOk?: (value: A) => void,
    ) => {
      if (!app) return;
      settle(f(app)).then(
        (r) => {
          if (r.ok) {
            setMessage(undefined);
            onOk?.(r.value);
          } else setMessage({ text: r.message, from: "action" });
        },
        // A defect: show a safe diagnostic, keep the detail in the console.
        (defect) => {
          console.error("task manager defect", defect);
          setMessage({
            text: "Unexpected error; see the browser console.",
            from: "action",
          });
        },
      );
    },
    [app],
  );

  const db = status.phase === "ready" ? status.db : undefined;
  return (
    <section data-testid="r1-task-manager" style={{ ...box, marginTop: 16 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>
        Task manager (SQLite)
      </h2>
      <p data-testid="r1-status" style={{ margin: "0 0 8px", color: "#555" }}>
        {status.phase === "loading" && "opening database…"}
        {status.phase === "failed" && `database failed: ${status.message}`}
        {db &&
          `SQLite ${db.version} · persistence ${db.persistence.actual} · ` +
            `loads ${loads} · last change: ${lastChange}`}
      </p>
      <form
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          act((a) =>
            a.createTask(title), () =>
            setTitle(""));
        }}
      >
        <input
          data-testid="r1-title"
          aria-label="New task title"
          placeholder="New task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ flex: "1 1 200px", minWidth: 0 }}
        />
        <button type="submit" data-testid="r1-add" disabled={!app}>
          Add task
        </button>
        <button
          type="button"
          data-testid="r1-reset"
          disabled={!app}
          onClick={() => act((a) => a.reset())}
        >
          Reset to seed
        </button>
      </form>
      {message && (
        <p
          role="alert"
          data-testid="r1-error"
          style={{ color: "#b00020", margin: "8px 0 0" }}
        >
          {message.text}
        </p>
      )}
      <ul
        data-testid="r1-tasks"
        style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}
      >
        {tasks.map((t) => (
          <li
            key={t.id}
            data-testid={`r1-task-${t.id}`}
            data-completed={String(t.completed)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              padding: "4px 0",
              borderBottom: "1px solid #eee",
            }}
          >
            <input
              type="checkbox"
              aria-label={`Complete task ${t.id}`}
              checked={t.completed}
              disabled={!app}
              onChange={(e) =>
                act((a) =>
                  e.target.checked
                    ? a.completeTask(t.id)
                    : a.updateTask(t.id, { completed: false })
                )}
            />
            <span style={{ color: "#888", minWidth: "2em" }}>#{t.id}</span>
            {editing?.id === t.id
              ? (
                <form
                  style={{ display: "flex", gap: 4, flex: "1 1 200px" }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(
                      (a) => a.updateTask(t.id, { title: editing.title }),
                      () => setEditing(undefined),
                    );
                  }}
                >
                  <input
                    data-testid="r1-edit-title"
                    aria-label={`Title of task ${t.id}`}
                    value={editing.title}
                    autoFocus
                    onChange={(e) =>
                      setEditing({ id: t.id, title: e.target.value })}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <button type="submit" data-testid="r1-save">Save</button>
                  <button type="button" onClick={() => setEditing(undefined)}>
                    Cancel
                  </button>
                </form>
              )
              : (
                <span
                  data-testid="r1-task-title"
                  style={{
                    flex: "1 1 200px",
                    minWidth: 0,
                    overflowWrap: "anywhere",
                    textDecoration: t.completed ? "line-through" : "none",
                  }}
                >
                  {t.title}
                </span>
              )}
            <small style={{ color: "#888" }}>{t.createdAt.slice(0, 10)}</small>
            {editing?.id !== t.id && (
              <button
                type="button"
                aria-label={`Rename task ${t.id}`}
                disabled={!app}
                onClick={() => setEditing({ id: t.id, title: t.title })}
              >
                Rename
              </button>
            )}
            <button
              type="button"
              aria-label={`Delete task ${t.id}`}
              disabled={!app}
              onClick={() => act((a) => a.deleteTask(t.id))}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      {app && tasks.length === 0 && (
        <p data-testid="r1-empty" style={{ color: "#888" }}>No tasks.</p>
      )}
    </section>
  );
}

/**
 * Publishes the hooks as `window.__playground.r1` for Playwright. The
 * playground creates `__playground` in its own effect, which may run after
 * this component's, so wait for it briefly (same as D1's workbench).
 */
export const exposeTaskManagerHooks = (hooks: TaskManagerHooks): void => {
  const target = globalThis as { __playground?: Record<string, unknown> };
  let tries = 0;
  const attach = () => {
    if (target.__playground) target.__playground.r1 = hooks;
    else if (tries++ < 100) setTimeout(attach, 20);
  };
  attach();
};
