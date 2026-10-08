// A small fetch-style API layer (plan.md §9 ApiHandler): routes are Effects
// that run on the ManagedRuntime the caller supplies, the handler takes a
// standard Request and returns a standard Response, and nothing here opens a
// socket. A browser page or a Deno test calls the function in-process.
//
// It is NOT a hardened server: there is no authentication, CORS, body-size
// limit or rate limit, so a server adapter must add those, and must only
// expose routes that are safe for every caller it serves (the task manager's
// opt-in `/sql` route is not). An aborted request (`request.signal`) is
// answered 499 and its effect interrupted; 499 means the outcome is unknown: a
// mutation that already reached the engine stays committed and published.
//
// Expected failures (the Effect error channel) go through the adapter's
// `mapError` to a status and a JSON body; anything else (defects, interrupts,
// a runtime that failed to build) becomes a 500 with a fixed safe body and the
// detail goes to `onDefect`, never to the client (project.md §5).
// Portable: no DOM, Deno or React imports beyond the Web Request/Response.
import { Cause, Effect, type ManagedRuntime } from "effect";
import {
  type ApiHandler,
  type Cell,
  encodeCell,
  type EncodedCell,
  type QueryResult,
} from "../core/types.ts";

export type { ApiHandler };

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * An HTTP-shaped expected failure: what the client is told. A route may fail
 * with one directly; `mapError` produces them from the application's errors.
 */
export class ApiFailure {
  constructor(
    readonly status: number,
    /** Stable machine-readable name, e.g. "InvalidInput". */
    readonly code: string,
    /** Safe to show to a person. */
    readonly message: string,
    readonly headers?: Readonly<Record<string, string>>,
  ) {}
}

/** A successful reply; `body` is serialized as JSON when present. */
export interface ApiReply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export const reply = (
  status: number,
  body?: unknown,
  headers?: Readonly<Record<string, string>>,
): ApiReply => ({ status, body, headers });

export const ok = (body?: unknown): ApiReply => reply(200, body);

export const created = (body: unknown, location?: string): ApiReply =>
  reply(201, body, location === undefined ? undefined : { location });

export const failure = (
  status: number,
  code: string,
  message: string,
  headers?: Readonly<Record<string, string>>,
): ApiFailure => new ApiFailure(status, code, message, headers);

/** What a route handler sees. */
export interface RouteContext {
  readonly request: Request;
  readonly url: URL;
  /** Decoded `:name` path segments. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /**
   * The request body parsed as JSON: `undefined` for an empty body, an
   * ApiFailure (400 InvalidJson) for malformed JSON. Read at most once.
   */
  readonly json: Effect.Effect<unknown, ApiFailure>;
}

export interface Route<R, E> {
  readonly method: ApiMethod;
  /** `/tasks/:id/complete`: literal segments and `:name` parameters. */
  readonly path: string;
  readonly handle: (
    context: RouteContext,
  ) => Effect.Effect<ApiReply, E | ApiFailure, R>;
}

export const route = <R, E>(
  method: ApiMethod,
  path: string,
  handle: Route<R, E>["handle"],
): Route<R, E> => ({ method, path, handle });

export interface ApiOptions<R, E> {
  /** The shared runtime every request runs on (the caller disposes it). */
  readonly runtime: ManagedRuntime.ManagedRuntime<R, unknown>;
  readonly routes: readonly Route<R, E>[];
  /** Expected failures of the application; total over E. */
  readonly mapError: (error: E) => ApiFailure;
  /** Defect detail for logs. Default: console.error. */
  readonly onDefect?: (cause: Cause.Cause<unknown>) => void;
}

const segments = (path: string): string[] =>
  path.split("/").filter((s) => s.length > 0);

/** Params when `pattern` matches `path`, else undefined. */
const matchPath = (
  pattern: readonly string[],
  path: readonly string[],
): Record<string, string> | "bad-encoding" | undefined => {
  if (pattern.length !== path.length) return undefined;
  const params: Record<string, string> = {};
  let badEncoding = false;
  for (let i = 0; i < pattern.length; i++) {
    const want = pattern[i];
    if (want.startsWith(":")) {
      try {
        params[want.slice(1)] = decodeURIComponent(path[i]);
      } catch {
        // Only a route whose literal segments all match can call this a 400.
        badEncoding = true;
      }
    } else if (want !== path[i]) return undefined;
  }
  return badEncoding ? "bad-encoding" : params;
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

const REASONS: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  499: "Client Closed Request",
  500: "Internal Server Error",
};

const toResponse = (r: ApiReply): Response => {
  const noBody = r.body === undefined || r.status === 204;
  return new Response(noBody ? null : JSON.stringify(r.body), {
    status: r.status,
    statusText: REASONS[r.status] ?? "",
    headers: noBody ? { ...r.headers } : { ...jsonHeaders, ...r.headers },
  });
};

const failureResponse = (f: ApiFailure): Response =>
  toResponse({
    status: f.status,
    body: { error: { code: f.code, message: f.message } },
    headers: f.headers,
  });

const INTERNAL = failure(
  500,
  "InternalError",
  "Unexpected error; the details are in the server log.",
);

/** The client went away (nginx's 499 convention); nothing is logged. */
const ABORTED = failure(499, "RequestAborted", "The request was aborted.");

/**
 * The fetch handler. It never rejects: every outcome is a Response.
 * Unknown paths are 404 RouteNotFound, a known path with another method is 405
 * with an Allow header, malformed JSON is 400 InvalidJson.
 */
export const makeApiHandler = <R, E>(
  options: ApiOptions<R, E>,
): ApiHandler => {
  const compiled = options.routes.map((r) => ({
    route: r,
    pattern: segments(r.path),
  }));
  const onDefect = options.onDefect ??
    ((cause: Cause.Cause<unknown>) =>
      console.error("api defect:", Cause.pretty(cause)));

  const dispatch = (request: Request): Effect.Effect<Response, never, R> => {
    const url = new URL(request.url);
    const path = segments(url.pathname);
    const matches: {
      route: Route<R, E>;
      params: Record<string, string>;
    }[] = [];
    for (const c of compiled) {
      const params = matchPath(c.pattern, path);
      if (params === "bad-encoding") {
        return Effect.succeed(failureResponse(
          failure(400, "InvalidPath", "Path contains invalid %-encoding."),
        ));
      }
      if (params) matches.push({ route: c.route, params });
    }
    if (matches.length === 0) {
      return Effect.succeed(failureResponse(
        failure(404, "RouteNotFound", `No route for ${url.pathname}.`),
      ));
    }
    const method = request.method.toUpperCase();
    const hit = matches.find((m) => m.route.method === method);
    if (!hit) {
      const allow = [...new Set(matches.map((m) => m.route.method))].sort()
        .join(", ");
      return Effect.succeed(failureResponse(
        failure(
          405,
          "MethodNotAllowed",
          `${method} is not allowed on ${url.pathname}; use ${allow}.`,
          { allow },
        ),
      ));
    }
    const json: Effect.Effect<unknown, ApiFailure> = Effect.tryPromise({
      try: () => request.text(),
      catch: () =>
        failure(400, "InvalidBody", "The request body is unreadable."),
    }).pipe(
      Effect.flatMap((text) =>
        text.trim() === "" ? Effect.succeed(undefined) : Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: () =>
            failure(400, "InvalidJson", "The body is not valid JSON."),
        })
      ),
    );
    const context: RouteContext = {
      request,
      url,
      params: hit.params,
      query: url.searchParams,
      json,
    };
    return hit.route.handle(context).pipe(
      Effect.map(toResponse),
      Effect.catch((e) =>
        Effect.succeed(
          failureResponse(e instanceof ApiFailure ? e : options.mapError(e)),
        )
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          onDefect(cause);
          return failureResponse(INTERNAL);
        })
      ),
    );
  };

  return async (request) => {
    if (request.signal.aborted) return failureResponse(ABORTED);
    try {
      return await options.runtime.runPromise(dispatch(request), {
        signal: request.signal,
      });
    } catch (error) {
      // Aborted while running: the effect was interrupted; not a defect.
      if (request.signal.aborted) return failureResponse(ABORTED);
      // The runtime itself failed (its layer did not build, or it was
      // disposed). Still a Response, never a rejection.
      onDefect(Cause.die(error));
      return failureResponse(INTERNAL);
    }
  };
};

// ---- cells -----------------------------------------------------------------

/** A QueryResult as JSON: every cell through encodeCell (plan.md §9). */
export interface EncodedQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly EncodedCell[])[];
  readonly changes: number;
  readonly schemaChanged: boolean;
  readonly truncated: boolean;
}

export const encodeQueryResult = (result: QueryResult): EncodedQueryResult => ({
  columns: result.columns,
  rows: result.rows.map((row) => row.map((cell: Cell) => encodeCell(cell))),
  changes: result.changes,
  schemaChanged: result.schemaChanged,
  truncated: result.truncated,
});
