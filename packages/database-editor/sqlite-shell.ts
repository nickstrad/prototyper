// Upstream sqlite3 (Fiddle) shell binding for the DatabaseEditor host. The
// shell runs inside R0's engine worker; this module owns the xterm surface,
// forwards typed lines to the worker's `shell` family and prints the shell's
// own output. Line buffering until `sqlite3_complete`, the continuation
// prompt and the `.open` block live in the worker (packages/database/
// worker.ts, shell family); the dot-command echo de-dup lives in
// line-console.ts. Nothing here interprets commands or formats results.
import { Effect, Exit, PubSub, Scope, Stream } from "effect";
import { Terminal } from "@xterm/xterm";
import type {
  DatabaseError,
  DatabaseService,
  EngineInfo,
  ShellError,
} from "../core/types.ts";
import {
  type EngineWorkerClient,
  type EngineWorkerOptions,
  engineWorkerScoped,
} from "../database/worker-client.ts";
import { shellSubmit } from "../database/sqlite-shell-client.ts";
import {
  makeSqliteShellService,
  seedSqliteShellService,
  type SqliteShellService,
} from "../database/sqlite-shell-service.ts";
import { attachLineConsole, type LineConsole } from "./line-console.ts";
import type { MountedShellBinding } from "./types.ts";

export interface SqliteShellBindingOptions {
  readonly client: EngineWorkerClient;
  readonly info: EngineInfo;
  /** The prototype's live database; the same engine instance as the shell. */
  readonly service: DatabaseService;
  readonly terminal?: {
    readonly cols?: number;
    readonly rows?: number;
    readonly fontSize?: number;
  };
}

const shellError = (
  operation: ShellError["operation"],
  message: string,
  cause: unknown = null,
): ShellError => ({ _tag: "ShellError", operation, message, cause });

const fromUnknown = (operation: ShellError["operation"]) => (e: unknown) =>
  shellError(
    operation,
    e instanceof Error ? e.message : String(e),
    e,
  );

export const makeSqliteShellBinding = (
  options: SqliteShellBindingOptions,
): Effect.Effect<MountedShellBinding, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { client, info, service } = options;
    const output = yield* PubSub.unbounded<string>();
    const history: string[] = [];
    let prompt = info.prompt;
    let terminal: Terminal | undefined;
    let console: LineConsole | undefined;
    // Submissions settle on the worker's prompt events, not on the console,
    // so an unmount mid-submission cannot strand a `submit`. One prompt event
    // ends one submission (FIFO); `inFlight` counts typed and programmatic
    // sends alike.
    let inFlight = 0;
    const submitWaiters: (() => void)[] = [];
    let idleWaiters: (() => void)[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    const send = (line: string) => {
      inFlight++;
      shellSubmit(client, line);
    };
    const whenIdle = () =>
      inFlight === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => idleWaiters.push(resolve));

    const unsubscribe = client.subscribe((event) => {
      if (event.family !== "shell") return;
      if (event.op === "output") {
        console?.output(event.stream, event.text);
        Effect.runFork(PubSub.publish(event.text)(output));
      } else if (event.op === "prompt") {
        prompt = event.text;
        inFlight = Math.max(0, inFlight - 1);
        submitWaiters.shift()?.();
        if (inFlight === 0) {
          const waiters = idleWaiters;
          idleWaiters = [];
          for (const resolve of waiters) resolve();
        }
        console?.prompt(event.text); // may replay typed keys and send again
      }
    });
    yield* Scope.addFinalizer(
      yield* Scope.Scope,
      Effect.sync(() => {
        unsubscribe();
        console?.dispose();
        terminal?.dispose();
        console = undefined;
        terminal = undefined;
      }),
    );

    const submitLine = (line: string): Promise<void> => {
      const next = chain.then(async () => {
        while (inFlight > 0) await whenIdle();
        return new Promise<void>((resolve) => {
          submitWaiters.push(resolve);
          if (console) console.submit(line);
          else send(line);
        });
      });
      chain = next.catch(() => {});
      return next;
    };

    const binding: MountedShellBinding = {
      engineInfo: info,
      get terminal() {
        return terminal;
      },
      sharesDatabaseWith: service,
      output: Stream.fromPubSub(output),
      ready: Effect.tryPromise(() => client.ready).pipe(
        Effect.mapError((e) => fromUnknown("ready")(e.cause)),
        Effect.asVoid,
      ),
      mount: (container) =>
        Effect.acquireRelease(
          Effect.try({
            try: () => {
              if (terminal) throw new Error("the shell is already mounted");
              const term = new Terminal({
                cols: options.terminal?.cols ?? 100,
                rows: options.terminal?.rows ?? 24,
                fontSize: options.terminal?.fontSize ?? 13,
                convertEol: false,
                scrollback: 5000,
              });
              term.open(container);
              const attached = attachLineConsole(term, {
                prompt,
                history,
                submit: send,
              });
              term.write(prompt);
              // No focus() here: a host may mount this beside other terminals
              // and must not steal the keyboard; clicking the console focuses it.
              terminal = term;
              console = attached;
              return { term, attached };
            },
            catch: fromUnknown("mount"),
          }),
          ({ term, attached }) =>
            Effect.sync(() => {
              attached.dispose();
              term.dispose();
              if (terminal === term) {
                terminal = undefined;
                console = undefined;
              }
            }),
        ).pipe(Effect.asVoid),
      submit: (line) =>
        Effect.tryPromise(() => submitLine(line)).pipe(
          Effect.mapError((e) => fromUnknown("submit")(e.cause)),
        ),
      idle: whenIdle,
      screen: () => {
        if (!terminal) return "";
        // Logical lines: rows xterm soft-wrapped are joined back together.
        const buffer = terminal.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i++) {
          const line = buffer.getLine(i);
          const text = line?.translateToString(true) ?? "";
          if (line?.isWrapped && lines.length > 0) {
            lines[lines.length - 1] += text;
          } else lines.push(text);
        }
        return lines.join("\n").replace(/\n+$/, "");
      },
    };
    return binding;
  });

export interface SqliteShellRuntimeOptions extends EngineWorkerOptions {
  /** Seed SQL run once at start and again on every host reset. */
  readonly seed?: string;
  readonly terminal?: SqliteShellBindingOptions["terminal"];
}

export interface SqliteShellRuntime {
  readonly client: EngineWorkerClient;
  readonly info: EngineInfo;
  readonly service: SqliteShellService;
  readonly binding: MountedShellBinding;
}

/**
 * Scoped acquisition of one prototype database: the engine worker, the DB0
 * service adapter (seeded) and the shell binding. Closing the scope disposes
 * the terminal, stops listening and terminates the worker.
 */
export const sqliteShellRuntime = (
  options: SqliteShellRuntimeOptions = {},
): Effect.Effect<
  SqliteShellRuntime,
  DatabaseError | ShellError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const client = yield* engineWorkerScoped(options);
    const info = yield* Effect.promise(() => client.ready);
    const service = yield* makeSqliteShellService(client, info, {
      seed: options.seed,
    });
    yield* Scope.addFinalizer(
      yield* Scope.Scope,
      Effect.sync(() => service.dispose()),
    );
    yield* seedSqliteShellService(service, options.seed);
    const binding = yield* makeSqliteShellBinding({
      client,
      info,
      service,
      terminal: options.terminal,
    });
    return { client, info, service, binding };
  });

/** Runs a scoped program from plain promise code (React effects, tests). */
export const openScope = (): {
  scope: Scope.Closeable;
  close(): Promise<void>;
} => {
  const scope = Effect.runSync(Scope.make());
  return {
    scope,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};
