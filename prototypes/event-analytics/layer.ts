// The event analytics prototype on D2's DuckDB DatabaseService. D2 is
// imported on first use only (inside the layer), so a page that never opens
// the analytics fetches none of DuckDB's engine, worker, wasm or Arrow code.
import { Effect, Layer } from "effect";
import type { Persistence } from "../../packages/core/types.ts";
import {
  type Database,
  DatabaseError,
} from "../../packages/database/sqlite-service.ts";
import { type EventAnalytics, layer } from "./application.ts";
import { EVENTS_SCHEMA_SQL, EVENTS_SEED_SQL } from "./seed.ts";

export type EventAnalyticsLayer = Layer.Layer<
  EventAnalytics | Database,
  DatabaseError
>;

export type EventAnalyticsDuckDbOptions = {
  /** "memory" (default here) or "opfs" (D2 falls back with a reason). */
  readonly persistence?: Persistence;
  /** Database name: `opfs://prototyper-<name>.duckdb`. */
  readonly name?: string;
  /** Delete the persisted file before opening. */
  readonly fresh?: boolean;
  /** Called after D2 terminated the worker (tests count disposals). */
  readonly onDispose?: () => void;
};

/**
 * Scoped layer: the DuckDB service (one worker, seeded with the events table
 * on first open) and the application over it. Releasing the layer closes the
 * app connection and terminates the worker (`db.terminate()`).
 */
export const eventAnalyticsDuckDbLayer = (
  options: EventAnalyticsDuckDbOptions = {},
): EventAnalyticsLayer =>
  layer.pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.tryPromise({
          try: () => import("../../packages/database/duckdb-service.ts"),
          catch: (cause) =>
            new DatabaseError({
              operation: "open",
              message: `cannot load the DuckDB service: ${String(cause)}`,
              cause,
            }),
        }).pipe(
          Effect.map((duckdb) =>
            duckdb.layer({
              persistence: options.persistence ?? "memory",
              name: options.name ?? "event-analytics",
              fresh: options.fresh,
              schema: EVENTS_SCHEMA_SQL,
              seed: EVENTS_SEED_SQL,
              onDispose: options.onDispose,
            })
          ),
        ),
      ),
    ),
  );
