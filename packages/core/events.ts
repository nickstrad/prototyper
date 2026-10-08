// Cross-interface coherence contract (R4). The change-notification mechanism
// itself is the DatabaseService's own `changes` stream / `subscribe` (plan.md
// §9, project.md §9): every write that succeeds through any interface (web
// UI, CLI, API, database editor) publishes exactly one DatabaseChange on the
// one service the prototype instance owns, and nothing is published on
// failure. This module gives the interfaces and the tests one vocabulary for
// observing that stream, classifying failures the same way everywhere, and
// comparing database state across interfaces. It has no DOM or Deno
// dependencies.
import { Data, Effect, PubSub, type Scope } from "effect";
import {
  type DatabaseChange,
  type DatabaseError,
  type DatabaseService,
  encodeCell,
  type EncodedCell,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Change sources: which interface publishes what (settled by R1-R3 and DB0).
// ---------------------------------------------------------------------------

/**
 * Who a DatabaseChange is attributed to:
 * - `app`: a write made through the application (web UI, CLI task commands,
 *   API task routes);
 * - `shell`: raw SQL typed in the application terminal (`db sql`) or in the
 *   upstream engine console;
 * - `host`: the editor host's reset/import controls and the API's opt-in
 *   `/sql` route.
 */
export type ChangeSource = DatabaseChange["source"];

export const CHANGE_SOURCES: readonly ChangeSource[] = ["app", "shell", "host"];

// ---------------------------------------------------------------------------
// Observing the stream
// ---------------------------------------------------------------------------

export interface ObservedChange {
  /** 1-based position in this observer's log. */
  readonly seq: number;
  readonly change: DatabaseChange;
  /** Milliseconds since the observer was created (monotonic). */
  readonly atMs: number;
}

export class CoherenceTimeout extends Data.TaggedError("CoherenceTimeout")<{
  readonly message: string;
  readonly waitedMs: number;
  readonly observed: readonly ObservedChange[];
}> {}

export interface ChangeObserver {
  /** Every change drained so far, in publication order. */
  readonly log: readonly ObservedChange[];
  /** Moves every change published so far into `log`; never suspends. */
  drain(): Effect.Effect<readonly ObservedChange[]>;
  /**
   * Drains until a change satisfies `predicate` (checked against the whole
   * log, so a change drained earlier also counts), or fails with
   * CoherenceTimeout.
   */
  waitFor(
    predicate: (change: DatabaseChange) => boolean,
    options?: { readonly timeoutMs?: number; readonly pollMs?: number },
  ): Effect.Effect<ObservedChange, CoherenceTimeout>;
  /** Number of drained changes per source. */
  countBySource(): Record<ChangeSource, number>;
  /** Changes drained after `seq` (exclusive). */
  since(seq: number): readonly ObservedChange[];
}

/**
 * Subscribes to the service's change PubSub for the lifetime of the scope.
 * The subscription exists from the moment this effect completes, so a write
 * made right after cannot be missed (the late-subscribing `Stream.fromPubSub`
 * path can miss one; see R1's lessons).
 */
export const observeChanges = (
  service: DatabaseService,
): Effect.Effect<ChangeObserver, never, Scope.Scope> =>
  Effect.gen(function* () {
    const subscription = yield* service.subscribe;
    const log: ObservedChange[] = [];
    const started = performance.now();
    const drain: ChangeObserver["drain"] = () =>
      Effect.map(
        PubSub.takeUpTo(subscription, Number.MAX_SAFE_INTEGER),
        (batch) => {
          const drained: ObservedChange[] = [];
          for (const change of batch) {
            const observed: ObservedChange = {
              seq: log.length + 1,
              change,
              atMs: performance.now() - started,
            };
            log.push(observed);
            drained.push(observed);
          }
          return drained;
        },
      );
    const waitFor: ChangeObserver["waitFor"] = (predicate, options = {}) => {
      const timeoutMs = options.timeoutMs ?? 2_000;
      const pollMs = options.pollMs ?? 10;
      // The deadline starts when the effect RUNS (Effect.suspend), so a
      // waitFor built earlier, or run twice, gets its full budget each time.
      return Effect.suspend(() => {
        const startedAt = performance.now();
        const deadline = startedAt + timeoutMs;
        const attempt: Effect.Effect<ObservedChange, CoherenceTimeout> = Effect
          .gen(function* () {
            yield* drain();
            const hit = log.find((o) => predicate(o.change));
            if (hit) return hit;
            if (performance.now() >= deadline) {
              return yield* new CoherenceTimeout({
                message: `no matching change within ${timeoutMs} ms`,
                waitedMs: Math.round(performance.now() - startedAt),
                observed: [...log],
              });
            }
            yield* Effect.sleep(pollMs);
            return yield* attempt;
          });
        return attempt;
      });
    };
    return {
      log,
      drain,
      waitFor,
      countBySource: () => {
        const counts: Record<ChangeSource, number> = {
          app: 0,
          shell: 0,
          host: 0,
        };
        for (const o of log) counts[o.change.source]++;
        return counts;
      },
      since: (seq) => log.filter((o) => o.seq > seq),
    };
  });

// ---------------------------------------------------------------------------
// Failure classification shared by every interface
// ---------------------------------------------------------------------------

/**
 * The one classification each interface renders in its own medium: the CLI
 * as stderr + exit code, the API as an HTTP status + JSON error body, the UI
 * as a banner, the console as the engine's own text.
 */
export type FailureKind =
  | "invalid-input"
  | "not-found"
  | "corrupt"
  | "database"
  | "shell"
  | "defect";

export interface FailureSummary {
  readonly kind: FailureKind;
  /** The tag the error carried, or "Defect". */
  readonly tag: string;
  readonly message: string;
  /** CLI exit status: 1 for every failure (usage errors, exit 2, are not failures). */
  readonly exitCode: 1;
  /** HTTP status the task routes answer (R3's opt-in `/sql` maps engine errors to 400 instead). */
  readonly httpStatus: 400 | 404 | 500;
}

const KIND_BY_TAG: Readonly<
  Record<
    string,
    { kind: FailureKind; httpStatus: FailureSummary["httpStatus"] }
  >
> = {
  InvalidInput: { kind: "invalid-input", httpStatus: 400 },
  TaskNotFound: { kind: "not-found", httpStatus: 404 },
  CorruptTask: { kind: "corrupt", httpStatus: 500 },
  DatabaseError: { kind: "database", httpStatus: 500 },
  ShellError: { kind: "shell", httpStatus: 500 },
};

const messageOf = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(error);
};

/** Classifies any failure value the interfaces can see. */
export const summarizeFailure = (error: unknown): FailureSummary => {
  const tag = typeof error === "object" && error !== null &&
      typeof (error as { _tag?: unknown })._tag === "string"
    ? (error as { _tag: string })._tag
    : "Defect";
  const known = KIND_BY_TAG[tag];
  return {
    kind: known?.kind ?? "defect",
    tag,
    message: messageOf(error),
    exitCode: 1,
    httpStatus: known?.httpStatus ?? 500,
  };
};

// ---------------------------------------------------------------------------
// Database snapshots: the same state seen from any interface
// ---------------------------------------------------------------------------

export interface TableSnapshot {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly EncodedCell[])[];
  /** The service cut the rows off; such a table never compares equal. */
  readonly truncated?: true;
}

/** Table name -> rows ordered by the first column; JSON-safe via encodeCell. */
export type Snapshot = Readonly<Record<string, TableSnapshot>>;

/** Row cap asked of the service per table (well above the services' 1000 default). */
export const SNAPSHOT_MAX_ROWS = 100_000;

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Reads every table (or the given ones) through the service. Rows are ordered
 * by the first column so two snapshots of equal content are equal. Up to
 * SNAPSHOT_MAX_ROWS rows per table are read; a table the service still
 * truncates is flagged `truncated` and never compares equal to anything, so a
 * snapshot can confirm equality only over data it fully holds.
 */
export const snapshot = (
  service: DatabaseService,
  tables?: readonly string[],
): Effect.Effect<Snapshot, DatabaseError> =>
  Effect.gen(function* () {
    const names = tables ?? (yield* service.tables());
    const out: Record<string, TableSnapshot> = {};
    for (const name of [...names].sort()) {
      const r = yield* service.execute(
        `SELECT * FROM ${quoteIdent(name)} ORDER BY 1`,
        { maxRows: SNAPSHOT_MAX_ROWS },
      );
      out[name] = {
        columns: r.columns,
        rows: r.rows.map((row) => row.map(encodeCell)),
        ...(r.truncated ? { truncated: true as const } : {}),
      };
    }
    return out;
  });

const hasTruncated = (s: Snapshot): boolean =>
  Object.values(s).some((t) => t.truncated === true);

/** Equal content on both sides; false whenever either side is truncated. */
export const sameSnapshot = (a: Snapshot, b: Snapshot): boolean =>
  !hasTruncated(a) && !hasTruncated(b) &&
  JSON.stringify(a) === JSON.stringify(b);

/** Human-readable first difference between two snapshots, or null. */
export const diffSnapshot = (a: Snapshot, b: Snapshot): string | null => {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const name of names) {
    const ta = a[name];
    const tb = b[name];
    if (!ta || !tb) return `table ${name} present on one side only`;
    if (ta.truncated || tb.truncated) {
      const side = ta.truncated && tb.truncated ? "both sides" : "one side";
      return `table ${name} is truncated on ${side}; cannot compare`;
    }
    const ja = JSON.stringify(ta);
    const jb = JSON.stringify(tb);
    if (ja !== jb) return `table ${name} differs:\n  ${ja}\n  ${jb}`;
  }
  return null;
};
