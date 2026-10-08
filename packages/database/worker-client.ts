// Main-thread client for the engine worker (plan.md §9 protocol). Plain
// promises and listeners so D1 (exec family) and DB0 (shell family) can wrap it
// in their own Effect services; `engineWorkerScoped` shows the scoped form.
import { Effect, type Scope } from "effect";
import type {
  DatabaseError,
  EngineInfo,
  QueryResult,
  WorkerEvent,
  WorkerRequest,
} from "../core/types.ts";

export type ExecOp = Extract<
  WorkerRequest,
  { family: "exec"; op: string }
>["op"];
export type ShellRequest = Extract<WorkerRequest, { family: "shell" }>;

export interface EngineWorkerOptions {
  /** URL prefix (ending in "/") of the vendored Fiddle assets. */
  readonly vendorDir?: string;
  /** Shell argv after argv[0]; defaults to Q17 flags inside the worker. */
  readonly args?: readonly string[];
  readonly name?: string;
}

export interface EngineWorkerClient {
  /** Resolves with engine facts once the worker loaded and started the engine. */
  readonly ready: Promise<EngineInfo>;
  readonly vendorDir: string;
  exec(sql: string, maxRows?: number): Promise<QueryResult>;
  op(op: ExecOp, arg?: unknown): Promise<QueryResult>;
  shell(request: ShellRequest): void;
  /** Receives every worker event, including exec replies. */
  subscribe(listener: (event: WorkerEvent) => void): () => void;
  terminate(): void;
}

/** `<base>/vendor/fiddle/` under Vite's BASE_URL (or "/" outside Vite). */
export const defaultVendorDir = (): string => {
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? "/"}vendor/fiddle/`;
};

const isDatabaseError = (e: unknown): e is DatabaseError =>
  typeof e === "object" && e !== null &&
  (e as { _tag?: unknown })._tag === "DatabaseError";

export const spawnEngineWorker = (
  options: EngineWorkerOptions = {},
): EngineWorkerClient => {
  const vendorDir = options.vendorDir ?? defaultVendorDir();
  // Classic worker on purpose; see worker.ts. Vite bundles it as an iife.
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    name: options.name ?? "engine-worker",
  });
  const listeners = new Set<(event: WorkerEvent) => void>();
  const pending = new Map<
    number,
    { resolve: (r: QueryResult) => void; reject: (e: DatabaseError) => void }
  >();
  let nextId = 1;
  let settled = false;
  let resolveReady!: (info: EngineInfo) => void;
  let rejectReady!: (error: DatabaseError) => void;
  const ready = new Promise<EngineInfo>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
    const m = event.data;
    if (m.family === "lifecycle" && !settled) {
      settled = true;
      if (m.op === "ready") resolveReady(m.info);
      else rejectReady(m.error);
    } else if (m.family === "exec") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p) m.ok ? p.resolve(m.result) : p.reject(m.error);
    }
    for (const l of listeners) l(m);
  };
  worker.onerror = (event) => {
    if (settled) return;
    settled = true;
    rejectReady({
      _tag: "DatabaseError",
      operation: "open",
      message: `engine worker failed to load: ${event.message}`,
      cause: event,
    });
  };
  // Avoid unhandled-rejection noise when nobody awaits `ready` directly.
  ready.catch(() => {});

  const send = (request: WorkerRequest) => worker.postMessage(request);
  const request = (
    build: (id: number) => WorkerRequest,
  ): Promise<QueryResult> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send(build(id));
    });

  send({ family: "lifecycle", op: "init", vendorDir, args: options.args });

  return {
    ready,
    vendorDir,
    exec: (sql, maxRows) =>
      request((id) => ({ family: "exec", id, sql, maxRows })),
    op: (op, arg) => request((id) => ({ family: "exec", id, op, arg })),
    shell: (req) => send(req),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    terminate: () => {
      worker.terminate();
      const error: DatabaseError = {
        _tag: "DatabaseError",
        operation: "open",
        message: "engine worker terminated",
        cause: null,
      };
      for (const p of pending.values()) p.reject(error);
      pending.clear();
      if (!settled) {
        settled = true;
        rejectReady(error);
      }
    },
  };
};

/**
 * Scoped acquisition: the worker is spawned and awaited; the scope finalizer
 * terminates it. Failure is a DatabaseError with operation "open".
 */
export const engineWorkerScoped = (
  options: EngineWorkerOptions = {},
): Effect.Effect<EngineWorkerClient, DatabaseError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const client = spawnEngineWorker(options);
      yield* Effect.tryPromise(() => client.ready).pipe(
        Effect.mapError((e): DatabaseError =>
          isDatabaseError(e.cause) ? e.cause : {
            _tag: "DatabaseError",
            operation: "open",
            message: `engine worker failed: ${String(e.cause)}`,
            cause: e.cause,
          }
        ),
        Effect.tapError(() => Effect.sync(() => client.terminate())),
      );
      return client;
    }),
    (client) => Effect.sync(() => client.terminate()),
  );
