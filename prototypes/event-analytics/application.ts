// Event analytics application core (R6): typed aggregate queries over the
// `events` table as an Effect service on the shared `Database` (D2's DuckDB
// DatabaseService in the browser). Every interface (the React panel here, the
// upstream DuckDB shell through the common editor) reads the same service, so
// the panel and a `SELECT` typed in the shell see the same numbers.
//
// - Aggregates are plain DuckDB SQL (AGGREGATE_SQL); the shell can run the
//   exact same text. Rows are decoded with Effect Schema: counts are
//   `number` (or `bigint` when unsafe, as D2 normalizes them), money and
//   percentages are DuckDB DECIMAL cells, i.e. exact decimal strings.
// - Expected failures are tagged. DatabaseError (D2's) when the SQL itself
//   fails, e.g. a column renamed or the table dropped from the shell;
//   AnalyticsDataError when the SQL succeeds but its cells do not decode
//   (e.g. a column whose type was changed) or the result was truncated.
//   A reset always recovers.
// - watchOverview() reloads from the service's change stream only (no
//   polling), so a write from the shell, the host or the app appears the
//   same way.
// Portable: no DOM, React or DuckDB imports.
import { Context, Effect, Layer, PubSub, Schema, type Stream } from "effect";
import type {
  Cell,
  DatabaseChange,
  DatabaseError,
  DatabaseService,
  QueryResult,
} from "../../packages/core/types.ts";
import { Database } from "../../packages/database/sqlite-service.ts";

export type { DatabaseError };

import { AGGREGATE_SQL } from "./queries.ts";

export { AGGREGATE_SQL };

// ---- domain types --------------------------------------------------------------

/** A row count: `number` when safe, `bigint` beyond 2^53 (D2's normalizer). */
const Count = Schema.Union([Schema.Number, Schema.BigInt]);
export type Count = typeof Count.Type;
/** A DuckDB DECIMAL cell: its exact text, e.g. "1234.50". */
const Decimal = Schema.String;

const TotalsRow = Schema.Tuple([Count, Count, Count, Decimal]);
const DayRow = Schema.Tuple([Schema.String, Count, Count]);
const SourceRow = Schema.Tuple([Schema.String, Count, Count, Decimal]);
const CountryRow = Schema.Tuple([
  Schema.String,
  Count,
  Count,
  Schema.NullOr(Decimal),
]);

export type Totals = {
  readonly events: Count;
  readonly views: Count;
  readonly signups: Count;
  /** Sum of signup revenue, exact decimal text. */
  readonly revenue: string;
};
export type DayStats = {
  readonly day: string;
  readonly views: Count;
  readonly signups: Count;
};
export type SourceStats = {
  readonly source: string;
  readonly events: Count;
  readonly signups: Count;
  readonly revenue: string;
};
export type CountryConversion = {
  readonly country: string;
  readonly views: Count;
  readonly signups: Count;
  /** signups per 100 page views, one decimal; null without page views. */
  readonly conversionPct: string | null;
};
export type Overview = {
  readonly totals: Totals;
  readonly perDay: readonly DayStats[];
  readonly sources: readonly SourceStats[];
  readonly countries: readonly CountryConversion[];
};

// ---- expected failures -----------------------------------------------------------

/** Input rejected by a schema; `message` is safe to show to a person. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()(
  "InvalidInput",
  { message: Schema.String },
) {}

/**
 * An aggregate query succeeded but its result is not what the app reads:
 * a cell does not decode (e.g. a column's type was changed so a count or an
 * amount arrives as something else), the row count is wrong, or the result
 * was truncated. Queries that fail outright (a renamed column, a dropped
 * table) are DatabaseError. Nothing was written; fix it with SQL or reset.
 */
export class AnalyticsDataError
  extends Schema.TaggedError<AnalyticsDataError>()(
    "AnalyticsDataError",
    { query: Schema.String, message: Schema.String },
  ) {}

export type AnalyticsError = DatabaseError | AnalyticsDataError;

/** Top sources shown by default; topSources() accepts 1..SOURCE_LIMIT_MAX. */
export const SOURCE_LIMIT_DEFAULT = 5;
export const SOURCE_LIMIT_MAX = 50;
const SourceLimit = Schema.Number.check(
  Schema.isInt({ message: "limit must be an integer" }),
  Schema.isBetween({ minimum: 1, maximum: SOURCE_LIMIT_MAX }, {
    message: `limit must be between 1 and ${SOURCE_LIMIT_MAX}`,
  }),
);

// ---- the service -----------------------------------------------------------------

export interface EventAnalyticsShape {
  totals(): Effect.Effect<Totals, AnalyticsError>;
  eventsPerDay(): Effect.Effect<readonly DayStats[], AnalyticsError>;
  /** Sources by event count (then name); `limit` defaults to 5. */
  topSources(
    limit?: unknown,
  ): Effect.Effect<readonly SourceStats[], AnalyticsError | InvalidInput>;
  conversionByCountry(): Effect.Effect<
    readonly CountryConversion[],
    AnalyticsError
  >;
  /** All four aggregates (what the panel renders). */
  overview(): Effect.Effect<Overview, AnalyticsError>;
  /** Aggregate queries run so far (tests: no polling, one reload per batch). */
  reads(): number;
  /** Back to exactly the seed (D2 reset re-applies schema + seed). */
  reset(): Effect.Effect<void, DatabaseError>;
  /** Every change published by the DatabaseService (app, shell or host). */
  readonly changes: Stream.Stream<DatabaseChange>;
  /** A subscription that exists before the caller's first read. */
  readonly subscribe: DatabaseService["subscribe"];
}

export class EventAnalytics extends Context.Service<
  EventAnalytics,
  EventAnalyticsShape
>()("prototyper/event-analytics/EventAnalytics") {}

/** Decodes every row of `result` with `row`; the first bad row fails. */
const decodeRows = <S extends Schema.Decoder<unknown>>(
  query: string,
  row: S,
) =>
(result: QueryResult): Effect.Effect<S["Type"][], AnalyticsDataError> =>
  Effect.forEach(
    result.rows,
    (cells: readonly Cell[], index) =>
      Schema.decodeUnknownEffect(row)(cells).pipe(
        Effect.mapError((e) =>
          new AnalyticsDataError({
            query,
            message: `${query} row ${index + 1}: ${
              e.message.split("\n")[0].trim()
            }`,
          })
        ),
      ),
  );

const query = <S extends Schema.Decoder<unknown>>(
  db: DatabaseService,
  name: keyof typeof AGGREGATE_SQL,
  row: S,
  onRead: () => void,
): Effect.Effect<S["Type"][], AnalyticsError> =>
  Effect.sync(onRead).pipe(
    Effect.andThen(db.execute(AGGREGATE_SQL[name])),
    Effect.flatMap((result) =>
      result.truncated
        ? Effect.fail(
          new AnalyticsDataError({
            query: name,
            message: `${name}: more rows than the service returns`,
          }),
        )
        : decodeRows(name, row)(result)
    ),
  );

/** The application over one DatabaseService (no other dependencies). */
export const makeEventAnalytics = (
  db: DatabaseService,
): EventAnalyticsShape => {
  let reads = 0;
  const onRead = () => {
    reads++;
  };
  const totals = () =>
    query(db, "totals", TotalsRow, onRead).pipe(
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.succeed(
            ((
              [events, views, signups, revenue],
            ): Totals => ({ events, views, signups, revenue }))(rows[0]),
          )
          : Effect.fail(
            new AnalyticsDataError({
              query: "totals",
              message: `totals: expected one row, got ${rows.length}`,
            }),
          )
      ),
    );
  const eventsPerDay = () =>
    query(db, "eventsPerDay", DayRow, onRead).pipe(
      Effect.map((rows) =>
        rows.map(([day, views, signups]): DayStats => ({
          day,
          views,
          signups,
        }))
      ),
    );
  const allSources = () =>
    query(db, "topSources", SourceRow, onRead).pipe(
      Effect.map((rows) =>
        rows.map(([source, events, signups, revenue]): SourceStats => ({
          source,
          events,
          signups,
          revenue,
        }))
      ),
    );
  const topSources = (limit: unknown = SOURCE_LIMIT_DEFAULT) =>
    Schema.decodeUnknownEffect(SourceLimit)(limit).pipe(
      Effect.mapError((e) =>
        new InvalidInput({ message: e.message.split("\n")[0].trim() })
      ),
      Effect.flatMap((n) =>
        allSources().pipe(Effect.map((rows) => rows.slice(0, n)))
      ),
    );
  const conversionByCountry = () =>
    query(db, "conversionByCountry", CountryRow, onRead).pipe(
      Effect.map((rows) =>
        rows.map(
          ([country, views, signups, conversionPct]): CountryConversion => ({
            country,
            views,
            signups,
            conversionPct,
          }),
        )
      ),
    );
  return {
    totals,
    eventsPerDay,
    topSources,
    conversionByCountry,
    overview: () =>
      Effect.all({
        totals: totals(),
        perDay: eventsPerDay(),
        sources: allSources().pipe(
          Effect.map((rows) => rows.slice(0, SOURCE_LIMIT_DEFAULT)),
        ),
        countries: conversionByCountry(),
      }),
    reads: () => reads,
    reset: () => db.reset(),
    changes: db.changes,
    subscribe: db.subscribe,
  };
};

export const layer: Layer.Layer<EventAnalytics, never, Database> = Layer
  .effect(EventAnalytics)(
    Effect.gen(function* () {
      return makeEventAnalytics(yield* Database);
    }),
  );

/** The application on an existing service (tests, shared engines). */
export const eventAnalyticsLayerFromService = (
  service: DatabaseService,
): Layer.Layer<EventAnalytics | Database> =>
  layer.pipe(Layer.provideMerge(Layer.succeed(Database)(service)));

// ---- the change-driven view ------------------------------------------------------

export type OverviewSnapshot = {
  readonly overview: Overview;
  /** The change events this reload answers (empty for the first load). */
  readonly changes: readonly DatabaseChange[];
  /** 1 for the initial load, then one more per reload. */
  readonly load: number;
};

/**
 * Loads the overview once, then again after every batch of change events
 * (events that arrive while a reload runs are coalesced into the next one).
 * `onChange` sees every event individually, in order, before the reload it
 * triggers. Runs until interrupted; the subscription is taken before the
 * first read, so no write between the two is missed.
 */
export const watchOverview = (
  onSnapshot: (snapshot: OverviewSnapshot) => void,
  onError: (error: AnalyticsError) => void = () => {},
  onChange: (change: DatabaseChange) => void = () => {},
): Effect.Effect<never, never, EventAnalytics> =>
  Effect.gen(function* () {
    const app = yield* EventAnalytics;
    return yield* Effect.scoped(Effect.gen(function* () {
      const subscription = yield* app.subscribe;
      let load = 0;
      const reload = (changes: readonly DatabaseChange[]) =>
        app.overview().pipe(
          Effect.match({
            onSuccess: (overview) =>
              onSnapshot({ overview, changes, load: ++load }),
            onFailure: onError,
          }),
        );
      yield* reload([]);
      return yield* Effect.forever(
        PubSub.takeAll(subscription).pipe(
          Effect.tap((changes) =>
            Effect.sync(() => {
              for (const change of changes) onChange(change);
            })
          ),
          Effect.flatMap(reload),
        ),
      );
    }));
  });

/** A message safe to show a person for an expected failure. */
export const describeAnalyticsError = (
  error: AnalyticsError | InvalidInput,
): string => {
  switch (error._tag) {
    case "InvalidInput":
      return `Invalid input: ${error.message}`;
    case "AnalyticsDataError":
      return `The events table cannot be read (${error.message}); ` +
        "fix it with SQL or reset";
    case "DatabaseError":
      return `Database error (${error.operation}): ${error.message}`;
  }
};
