// API explorer (R3): pick a method, path and JSON body, call the task
// manager's fetch handler in this page and see the status, headers and body.
// There is no network transport: the form builds a standard Request and hands
// it straight to the ApiHandler (prototypes/task-manager/api.ts), which runs
// on a ManagedRuntime built from the same layer as the task manager panel.
// With the playground's layer that is the page's one DatabaseService, so a
// task created here arrives in the task manager through the `changes` stream.
import { useEffect, useRef, useState } from "react";
import { ManagedRuntime } from "effect";
import type { ApiHandler } from "../../packages/api/router.ts";
import type { DatabaseService } from "../../packages/core/types.ts";
import { createTaskApiHandler } from "../../prototypes/task-manager/api.ts";
import type { TaskManagerLayer } from "../../prototypes/task-manager/App.tsx";
import { Database } from "../../packages/database/sqlite-service.ts";

/**
 * Requests are built against this origin only because `Request` needs an
 * absolute URL. `.invalid` never resolves, so a request that escaped to the
 * network could not succeed silently.
 */
export const API_ORIGIN = "https://api.invalid";

/** The most recent calls kept for `calls()` and the visible history. */
export const MAX_CALLS = 10;

const DISPOSED = "explorer disposed (the page unmounted its runtime)";
const disposedResponse = () =>
  new Response(
    JSON.stringify({ error: { code: "ExplorerDisposed", message: DISPOSED } }),
    { status: 503, headers: { "content-type": "application/json" } },
  );

export const METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
type Method = typeof METHODS[number];

/** What one call looked like, newest last. */
export interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly status: number;
}

/** Test hooks the playground exposes as `window.__playground.r3`. */
export interface ApiExplorerHooks {
  /** The DatabaseService the explorer's runtime runs on (R1's: one engine). */
  readonly service: DatabaseService;
  /** The handler under test: calling it is the only way requests are served. */
  readonly handler: ApiHandler;
  /** The last MAX_CALLS handler invocations (the form's and hooks.call's). */
  calls(): readonly ApiCall[];
  /** Sends a request through the handler, as the form's Send button does. */
  call(method: string, path: string, body?: string): Promise<{
    status: number;
    body: string;
  }>;
}

type Preset = {
  readonly label: string;
  readonly method: Method;
  readonly path: string;
  readonly body?: string;
};

export const PRESETS: readonly Preset[] = [
  { label: "List tasks", method: "GET", path: "/tasks" },
  { label: "Get task 1", method: "GET", path: "/tasks/1" },
  {
    label: "Create task",
    method: "POST",
    path: "/tasks",
    body: '{ "title": "Created from the API explorer" }',
  },
  {
    label: "Rename task 2",
    method: "PATCH",
    path: "/tasks/2",
    body: '{ "title": "Renamed from the API explorer" }',
  },
  { label: "Complete task 2", method: "POST", path: "/tasks/2/complete" },
  { label: "Delete task 3", method: "DELETE", path: "/tasks/3" },
  { label: "Reset to seed", method: "POST", path: "/reset" },
  {
    label: "400: blank title",
    method: "POST",
    path: "/tasks",
    body: '{ "title": "   " }',
  },
  { label: "404: missing task", method: "GET", path: "/tasks/999" },
  {
    label: "SQL with bigint and blob",
    method: "POST",
    path: "/sql",
    body: '{ "sql": "SELECT 9007199254740993, x\'00ff\'" }',
  },
];

type Shown =
  | {
    readonly kind: "response";
    readonly status: number;
    readonly statusText: string;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: string;
    readonly ms: number;
  }
  | { readonly kind: "error"; readonly message: string };

type Status =
  | { phase: "loading" }
  | { phase: "ready"; version: string }
  | { phase: "failed"; message: string };

const box = {
  border: "1px solid #ccc",
  borderRadius: 4,
  padding: 8,
} as const;

const pre = {
  margin: "4px 0 0",
  padding: 8,
  background: "#f6f6f6",
  overflow: "auto",
  maxHeight: 260,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
} as const;

const prettyBody = (text: string): string => {
  try {
    return text === "" ? "" : JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

/**
 * `layer` and `onHooks` must be referentially stable: a new identity disposes
 * the runtime and builds a new one (the same rule as TaskManagerApp). Pass the
 * layer the task manager panel uses so both share one database.
 */
export function ApiExplorer(props: {
  readonly layer: () => TaskManagerLayer;
  readonly onHooks?: (hooks: ApiExplorerHooks) => void;
}) {
  const { layer, onHooks } = props;
  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [method, setMethod] = useState<Method>("GET");
  const [path, setPath] = useState("/tasks");
  const [body, setBody] = useState("");
  const [shown, setShown] = useState<Shown | undefined>();
  const [history, setHistory] = useState<readonly ApiCall[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const send = useRef<
    ((m: string, p: string, b?: string) => Promise<Shown>) | undefined
  >(undefined);

  useEffect(() => {
    const runtime = ManagedRuntime.make(layer());
    // /sql is on for the explorer only (it runs arbitrary SQL; see api.ts).
    const handler = createTaskApiHandler(runtime, { sql: true });
    const calls: ApiCall[] = [];
    let count = 0;
    let live = true;

    /** The one place a Request is built and the handler invoked. */
    const invoke = async (
      m: string,
      p: string,
      b?: string,
    ): Promise<Shown> => {
      let request: Request;
      try {
        const hasBody = b !== undefined && b.trim() !== "";
        request = new Request(`${API_ORIGIN}${p}`, {
          method: m,
          ...(hasBody
            ? { body: b, headers: { "content-type": "application/json" } }
            : {}),
        });
      } catch (e) {
        return {
          kind: "error",
          message: `Cannot build the request: ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
      }
      const started = performance.now();
      const response = await handler(request);
      const text = await response.text();
      const call = {
        method: m,
        path: p,
        url: request.url,
        status: response.status,
      };
      calls.push(call);
      count++;
      if (calls.length > MAX_CALLS) calls.shift();
      return {
        kind: "response",
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body: prettyBody(text),
        ms: Math.round(performance.now() - started),
      };
    };
    /** Calls the handler and shows the outcome (one state batch). */
    const run = async (m: string, p: string, b?: string): Promise<Shown> => {
      if (!live) return { kind: "error", message: DISPOSED };
      const shownNow = await invoke(m, p, b);
      if (live) {
        setShown(shownNow);
        setHistory(calls.slice());
        setTotal(count);
      }
      return shownNow;
    };
    send.current = run;

    runtime.runPromise(Database).then(
      (db) => {
        if (!live) return;
        setStatus({ phase: "ready", version: db.version });
        onHooks?.({
          service: db,
          // After unmount the runtime is disposed: answer clearly instead.
          handler: (request) =>
            live ? handler(request) : Promise.resolve(disposedResponse()),
          calls: () => calls,
          call: async (m, p, b) => {
            const r = await run(m, p, b);
            return r.kind === "response"
              ? { status: r.status, body: r.body }
              : { status: 0, body: r.message };
          },
        });
      },
      (e: { message?: string }) =>
        live &&
        setStatus({ phase: "failed", message: e?.message ?? String(e) }),
    );
    return () => {
      live = false;
      send.current = undefined;
      void runtime.dispose();
    };
  }, [layer, onHooks]);

  const ready = status.phase === "ready";
  return (
    <section data-testid="r3-api-explorer" style={{ ...box, marginTop: 16 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>
        API explorer (task manager)
      </h2>
      <p data-testid="r3-status" style={{ margin: "0 0 8px", color: "#555" }}>
        {status.phase === "loading" && "connecting to the shared database…"}
        {status.phase === "failed" && `database failed: ${status.message}`}
        {status.phase === "ready" &&
          `Handler ready on the shared SQLite ${status.version} · ` +
            `handler calls ${total} · ` +
            "transport: none (the handler is called in this page)"}
      </p>
      <div
        style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}
      >
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            data-testid="r3-preset"
            onClick={() => {
              setMethod(p.method);
              setPath(p.path);
              setBody(p.body ?? "");
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <form
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        onSubmit={(e) => {
          e.preventDefault();
          const invoke = send.current;
          if (!invoke) {
            return;
          }
          setBusy(true);
          invoke(method, path, body).finally(() =>
            setBusy(false)
          );
        }}
      >
        <select
          data-testid="r3-method"
          aria-label="Method"
          value={method}
          onChange={(e) => setMethod(e.target.value as Method)}
        >
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input
          data-testid="r3-path"
          aria-label="Path"
          placeholder="/tasks"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          style={{ flex: "1 1 200px", minWidth: 0, fontFamily: "monospace" }}
        />
        <button type="submit" data-testid="r3-send" disabled={!ready || busy}>
          Send
        </button>
        <textarea
          data-testid="r3-body"
          aria-label="JSON body"
          placeholder='JSON body, e.g. { "title": "Write docs" }'
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          style={{
            flex: "1 1 100%",
            minWidth: 0,
            fontFamily: "monospace",
            boxSizing: "border-box",
          }}
        />
      </form>
      {shown?.kind === "error" && (
        <p
          role="alert"
          data-testid="r3-error"
          style={{ color: "#b00020", margin: "8px 0 0" }}
        >
          {shown.message}
        </p>
      )}
      {shown?.kind === "response" && (
        <div data-testid="r3-response" style={{ marginTop: 8 }}>
          <strong data-testid="r3-response-status">
            {shown.status} {shown.statusText}
          </strong>{" "}
          <small style={{ color: "#888" }}>{shown.ms} ms</small>
          <pre data-testid="r3-response-headers" style={pre}>
            {shown.headers.map(([k, v]) => `${k}: ${v}`).join("\n")}
          </pre>
          <pre data-testid="r3-response-body" style={pre}>{shown.body}</pre>
        </div>
      )}
      {history.length > 0 && (
        <ol
          data-testid="r3-history"
          style={{ margin: "8px 0 0", paddingLeft: 20, color: "#555" }}
        >
          {history.map((c, i) => (
            <li key={i} style={{ overflowWrap: "anywhere" }}>
              {c.method} {c.path} → {c.status}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Publishes the hooks as `window.__playground.r3` for Playwright, waiting for
 * the playground to create `__playground` (same approach as R1's hooks).
 */
export const exposeApiExplorerHooks = (hooks: ApiExplorerHooks): void => {
  const target = globalThis as { __playground?: Record<string, unknown> };
  let tries = 0;
  const attach = () => {
    if (target.__playground) target.__playground.r3 = hooks;
    else if (tries++ < 100) setTimeout(attach, 20);
  };
  attach();
};
