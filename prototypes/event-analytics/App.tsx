// Event analytics React UI (R6): the aggregates of the events table, rendered
// only from the DuckDB service's `changes` stream (watchOverview; no
// polling), plus an on-demand Database view that mounts DB0's common
// DatabaseEditor with DB1's upstream DuckDB shell binding on the same
// service. A SELECT typed in that shell shows the panel's numbers; an INSERT
// there reaches the panel as one change event.
//
// Lifecycle (plan.md Q18): the DuckDB shell is a page singleton, embedded
// once per prototype instance. The binding is created the first time the
// Database view opens; hiding the view only moves the shell's element out
// of the page. Closing the analytics (or the playground instance) disposes
// the shell's terminal first, then releases the layer, which terminates the
// DuckDB worker. Nothing DuckDB-related loads before "Open event analytics";
// the shell and its wasm load only when the Database view first opens.
import { useCallback, useEffect, useRef, useState } from "react";
import { Effect, Exit, Fiber, ManagedRuntime, Scope } from "effect";
import {
  type DatabaseChange,
  type DatabaseService,
  encodeCell,
  type EncodedCell,
  type Persistence,
} from "../../packages/core/types.ts";
import { type Snapshot, snapshot } from "../../packages/core/events.ts";
import { Database } from "../../packages/database/sqlite-service.ts";
import { DatabaseEditor } from "../../packages/database-editor/DatabaseEditor.tsx";
import {
  type DuckDbShellBinding,
  type EncodedQueryResult,
  makeDuckDbShellBinding,
} from "../../packages/database-editor/duckdb-shell.ts";
import {
  type AnalyticsError,
  type Count,
  describeAnalyticsError,
  EventAnalytics,
  type EventAnalyticsShape,
  type Overview,
  watchOverview,
} from "./application.ts";
import {
  eventAnalyticsDuckDbLayer,
  type EventAnalyticsLayer,
} from "./layer.ts";

// ---- test hooks ----------------------------------------------------------------

/** An Overview with every count passed through encodeCell (JSON-safe). */
export type EncodedOverview = {
  readonly totals: {
    readonly events: EncodedCell;
    readonly views: EncodedCell;
    readonly signups: EncodedCell;
    readonly revenue: string;
  };
  readonly perDay: readonly {
    readonly day: string;
    readonly views: EncodedCell;
    readonly signups: EncodedCell;
  }[];
  readonly sources: readonly {
    readonly source: string;
    readonly events: EncodedCell;
    readonly signups: EncodedCell;
    readonly revenue: string;
  }[];
  readonly countries: readonly {
    readonly country: string;
    readonly views: EncodedCell;
    readonly signups: EncodedCell;
    readonly conversionPct: string | null;
  }[];
};

export const encodeOverview = (o: Overview): EncodedOverview => ({
  totals: {
    events: encodeCell(o.totals.events),
    views: encodeCell(o.totals.views),
    signups: encodeCell(o.totals.signups),
    revenue: o.totals.revenue,
  },
  perDay: o.perDay.map((d) => ({
    day: d.day,
    views: encodeCell(d.views),
    signups: encodeCell(d.signups),
  })),
  sources: o.sources.map((s) => ({
    source: s.source,
    events: encodeCell(s.events),
    signups: encodeCell(s.signups),
    revenue: s.revenue,
  })),
  countries: o.countries.map((c) => ({
    country: c.country,
    views: encodeCell(c.views),
    signups: encodeCell(c.signups),
    conversionPct: c.conversionPct,
  })),
});

/** One open analytics instance (`window.__playground.r6.instance()`). */
export interface EventAnalyticsInstanceHooks {
  readonly service: DatabaseService;
  readonly app: EventAnalyticsShape;
  /** Panel reloads so far (1 = initial load); grows only on change events. */
  loads(): number;
  /** Aggregate queries the application has run (4 per overview). */
  reads(): number;
  /** Every change event the panel received since it opened, in order. */
  changes(): readonly DatabaseChange[];
  /** What the panel renders right now. */
  rendered(): EncodedOverview | undefined;
  /** A fresh read of the aggregates through the application. */
  overview(): Promise<EncodedOverview>;
  /** R4's snapshot of every table through the service. */
  snapshot(): Promise<Snapshot>;
  /** App-side SQL through the service (source "app"). */
  execute(sql: string): Promise<EncodedQueryResult>;
  reset(): Promise<void>;
  /** Opens (and on first use creates) the Database view. */
  openDatabaseView(): Promise<void>;
  binding(): DuckDbShellBinding | undefined;
  /** The shell's terminal text ("" before the view first opened). */
  screen(): string;
  idle(): Promise<void>;
}

/** `window.__playground.r6` (tests/duckdb/*.spec.ts). */
export interface EventAnalyticsHooks {
  /** Shows the analytics (loads DuckDB); same as the Open button. */
  open(): void;
  /** Unmounts the analytics: shell disposed, worker terminated. */
  close(): void;
  isOpen(): boolean;
  /** The open instance once its first load rendered. */
  instance(): EventAnalyticsInstanceHooks | undefined;
  /** Instances that started DuckDB on this page. */
  starts(): number;
  /** Started instances fully released since (worker terminated). */
  disposals(): number;
}

// ---- formatting ------------------------------------------------------------------

const count = (c: Count): string =>
  typeof c === "bigint" ? c.toString() : String(c);
const toNumber = (c: Count): number => Number(c);

const box = {
  border: "1px solid #ccc",
  borderRadius: 4,
  padding: 8,
} as const;
const styles = {
  tiles: { display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0" },
  tile: {
    ...box,
    flex: "1 1 120px",
    minWidth: 0,
    background: "#fafafa",
  },
  tileLabel: { fontSize: 12, color: "#555" },
  tileValue: {
    fontSize: 20,
    fontVariantNumeric: "tabular-nums",
    overflowWrap: "anywhere",
  },
  tables: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    alignItems: "flex-start",
  },
  tableBox: { flex: "1 1 260px", minWidth: 0, overflowX: "auto" },
  table: {
    borderCollapse: "collapse",
    fontSize: 12,
    width: "100%",
    fontVariantNumeric: "tabular-nums",
  },
  th: {
    textAlign: "left",
    borderBottom: "1px solid #ccc",
    padding: "2px 6px",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "2px 6px",
    borderBottom: "1px solid #eee",
    whiteSpace: "nowrap",
  },
  num: { textAlign: "right" },
  bar: { height: 8, background: "#6b8fd8", borderRadius: 2 },
  h3: { fontSize: 14, margin: "0 0 4px" },
  controls: { display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0" },
  error: { color: "#b00020", margin: "8px 0 0" },
} as const;

const Tile = (
  { label, value, testid }: { label: string; value: string; testid: string },
) => (
  <div style={styles.tile}>
    <div style={styles.tileLabel}>{label}</div>
    <div data-testid={testid} style={styles.tileValue}>{value}</div>
  </div>
);

const describeChange = (c: DatabaseChange): string =>
  c.kind === "write"
    ? `write from ${c.source} (${c.changes} row${c.changes === 1 ? "" : "s"}${
      c.schemaChanged ? ", schema" : ""
    })`
    : `${c.kind} by ${c.source}`;

function OverviewView({ overview }: { overview: Overview }) {
  const { totals, perDay, sources, countries } = overview;
  const maxViews = Math.max(1, ...perDay.map((d) => toNumber(d.views)));
  return (
    <>
      <div data-testid="r6-totals" style={styles.tiles}>
        <Tile
          label="Events"
          value={count(totals.events)}
          testid="r6-total-events"
        />
        <Tile
          label="Page views"
          value={count(totals.views)}
          testid="r6-total-views"
        />
        <Tile
          label="Signups"
          value={count(totals.signups)}
          testid="r6-total-signups"
        />
        <Tile
          label="Revenue"
          value={totals.revenue}
          testid="r6-total-revenue"
        />
      </div>
      <div style={styles.tables}>
        <div style={styles.tableBox}>
          <h3 style={styles.h3}>Events per day</h3>
          <table data-testid="r6-per-day" style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>day</th>
                <th style={{ ...styles.th, ...styles.num }}>views</th>
                <th style={{ ...styles.th, ...styles.num }}>signups</th>
                <th
                  style={{ ...styles.th, width: "40%" }}
                  aria-label="views bar"
                />
              </tr>
            </thead>
            <tbody>
              {perDay.map((d) => (
                <tr key={d.day} data-row={d.day}>
                  <td style={styles.td}>{d.day}</td>
                  <td style={{ ...styles.td, ...styles.num }}>
                    {count(d.views)}
                  </td>
                  <td style={{ ...styles.td, ...styles.num }}>
                    {count(d.signups)}
                  </td>
                  <td style={styles.td}>
                    <div
                      style={{
                        ...styles.bar,
                        width: `${(100 * toNumber(d.views)) / maxViews}%`,
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={styles.tableBox}>
          <h3 style={styles.h3}>Top sources</h3>
          <table data-testid="r6-sources" style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>source</th>
                <th style={{ ...styles.th, ...styles.num }}>events</th>
                <th style={{ ...styles.th, ...styles.num }}>signups</th>
                <th style={{ ...styles.th, ...styles.num }}>revenue</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.source} data-row={s.source}>
                  <td style={styles.td}>{s.source}</td>
                  <td style={{ ...styles.td, ...styles.num }}>
                    {count(s.events)}
                  </td>
                  <td style={{ ...styles.td, ...styles.num }}>
                    {count(s.signups)}
                  </td>
                  <td style={{ ...styles.td, ...styles.num }}>{s.revenue}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 style={{ ...styles.h3, marginTop: 12 }}>Conversion by country</h3>
          <table data-testid="r6-countries" style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>country</th>
                <th style={{ ...styles.th, ...styles.num }}>views</th>
                <th style={{ ...styles.th, ...styles.num }}>signups</th>
                <th style={{ ...styles.th, ...styles.num }}>conversion %</th>
              </tr>
            </thead>
            <tbody>
              {countries.map((c) => (
                <tr key={c.country} data-row={c.country}>
                  <td style={styles.td}>{c.country}</td>
                  <td style={{ ...styles.td, ...styles.num }}>
                    {count(c.views)}
                  </td>
                  <td style={{ ...styles.td, ...styles.num }}>
                    {count(c.signups)}
                  </td>
                  <td style={{ ...styles.td, ...styles.num }}>
                    {c.conversionPct ?? "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ---- one analytics instance ------------------------------------------------------

type Status =
  | { phase: "loading" }
  | { phase: "ready"; app: EventAnalyticsShape; db: DatabaseService }
  | { phase: "failed"; message: string };

type DbView =
  | { phase: "closed" }
  | { phase: "starting" }
  | { phase: "ready"; binding: DuckDbShellBinding; visible: boolean }
  | { phase: "failed"; message: string };

const getBoth = Effect.gen(function* () {
  return { app: yield* EventAnalytics, db: yield* Database };
});

/**
 * One analytics instance: builds the runtime from `layer` on mount and
 * releases it on unmount. `layer` and `onHooks` must be referentially stable.
 */
export function EventAnalyticsApp(props: {
  readonly layer: () => EventAnalyticsLayer;
  readonly onHooks?: (hooks: EventAnalyticsInstanceHooks | undefined) => void;
  /** Called when the instance starts building its runtime. */
  readonly onStarted?: () => void;
  /** Called once a started instance's resources are all released. */
  readonly onDisposed?: () => void;
}) {
  const { layer, onHooks, onStarted, onDisposed } = props;
  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const [overview, setOverview] = useState<Overview>();
  const [loads, setLoads] = useState(0);
  const [notifications, setNotifications] = useState(0);
  const [lastChange, setLastChange] = useState("none yet");
  const [message, setMessage] = useState<string>();
  const [dbView, setDbView] = useState<DbView>({ phase: "closed" });
  /** Opens the Database view; set by the effect below. */
  const openViewRef = useRef<() => Promise<void>>(undefined);

  useEffect(() => {
    let live = true;
    let runtime:
      | ManagedRuntime.ManagedRuntime<
        EventAnalytics | Database,
        unknown
      >
      | undefined;
    let started: Promise<void> | undefined;
    let fiber: Fiber.Fiber<never, unknown> | undefined;
    let shell:
      | { scope: Scope.Closeable; binding: Promise<DuckDbShellBinding> }
      | undefined;
    let service: DatabaseService | undefined;
    /** The shell binding once created (kept until the instance closes). */
    let shellBinding: DuckDbShellBinding | undefined;
    const changes: DatabaseChange[] = [];
    let current: Overview | undefined;
    let loadCount = 0;

    const openView = async () => {
      if (!live || !service) throw new Error("the analytics is not ready");
      if (!shell) {
        const scope = Effect.runSync(Scope.make());
        const db = service;
        const binding = Effect.runPromise(
          Scope.provide(scope)(
            makeDuckDbShellBinding(db, { height: "360px" }),
          ),
        );
        shell = { scope, binding };
        setDbView({ phase: "starting" });
        try {
          const b = await binding;
          shellBinding = b;
          if (live) setDbView({ phase: "ready", binding: b, visible: true });
        } catch (e) {
          // Typically Q18: another DuckDB shell owns the page. Free what
          // was acquired so a later attempt can succeed.
          if (shell?.scope === scope) shell = undefined;
          await Effect.runPromise(Scope.close(scope, Exit.void));
          const text = (e as { message?: string }).message ?? String(e);
          if (live) setDbView({ phase: "failed", message: text });
          throw e;
        }
        return;
      }
      const b = await shell.binding;
      if (live) setDbView({ phase: "ready", binding: b, visible: true });
    };
    openViewRef.current = openView;

    const start = () => {
      onStarted?.();
      runtime = ManagedRuntime.make(layer());
      const rt = runtime;
      started = rt.runPromise(getBoth).then(
        ({ app, db }) => {
          if (!live) return;
          service = db;
          fiber = rt.runFork(watchOverview(
            (snap) => {
              if (!live) return;
              current = snap.overview;
              loadCount = snap.load;
              setOverview(snap.overview);
              setLoads(snap.load);
              setMessage(undefined);
              const last = snap.changes.at(-1);
              if (last) {
                setLastChange(
                  describeChange(last) +
                    (snap.changes.length > 1
                      ? ` (+${snap.changes.length - 1} coalesced)`
                      : ""),
                );
              }
            },
            (e: AnalyticsError) =>
              live && setMessage(describeAnalyticsError(e)),
            (change) => {
              changes.push(change);
              if (live) setNotifications(changes.length);
            },
          ));
          setStatus({ phase: "ready", app, db });
          onHooks?.({
            service: db,
            app,
            loads: () => loadCount,
            reads: () => app.reads(),
            changes: () => [...changes],
            rendered: () => current && encodeOverview(current),
            overview: () =>
              Effect.runPromise(app.overview()).then(encodeOverview),
            snapshot: () => Effect.runPromise(snapshot(db)),
            execute: (sql) =>
              Effect.runPromise(db.execute(sql)).then((r) => ({
                ...r,
                rows: r.rows.map((row) => row.map(encodeCell)),
              })),
            reset: () => Effect.runPromise(app.reset()),
            openDatabaseView: openView,
            binding: () => shellBinding,
            screen: () => shellBinding?.screen() ?? "",
            idle: () => shellBinding?.idle() ?? Promise.resolve(),
          });
        },
        (e: { message?: string }) => {
          if (live) {
            setStatus({ phase: "failed", message: e?.message ?? String(e) });
          }
        },
      );
    };
    // Deferred one task: React StrictMode's mount-unmount-mount in dev then
    // never starts (and terminates) a throwaway DuckDB worker.
    const timer = setTimeout(start, 0);

    return () => {
      live = false;
      clearTimeout(timer);
      onHooks?.(undefined);
      void (async () => {
        try {
          // A start in flight finishes first: closing the layer under D2's
          // startup would run the rest of it on a terminated worker.
          await started?.catch(() => undefined);
          if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
          // The shell first (its terminal and its wrappers on the instance),
          // then the layer (app connection, worker). Captured before the
          // await: a binding that fails meanwhile (Q18) clears `shell` in
          // openView, which also closes the scope; closing twice is harmless.
          const s = shell;
          if (s) {
            await s.binding.catch(() => undefined);
            await Effect.runPromise(Scope.close(s.scope, Exit.void));
          }
        } catch (e) {
          console.error("event analytics: shell cleanup failed", e);
        } finally {
          // Never skipped: the layer owns the DuckDB worker.
          if (runtime) {
            await runtime.dispose().catch((e: unknown) =>
              console.error("event analytics: dispose failed", e)
            );
            onDisposed?.();
          }
        }
      })();
    };
  }, [layer, onHooks, onStarted, onDisposed]);

  const openView = useCallback(() => {
    void openViewRef.current?.().catch(() => undefined);
  }, []);

  const app = status.phase === "ready" ? status.app : undefined;
  const db = status.phase === "ready" ? status.db : undefined;
  const onReset = () => {
    if (!app) return;
    Effect.runPromise(Effect.result(app.reset())).then((r) => {
      if (r._tag === "Failure") setMessage(describeAnalyticsError(r.failure));
    });
  };

  return (
    <div data-testid="r6-panel">
      <p data-testid="r6-status" style={{ margin: "0 0 4px", color: "#555" }}>
        {status.phase === "loading" && "starting DuckDB…"}
        {status.phase === "failed" && `database failed: ${status.message}`}
        {db &&
          `DuckDB ${db.version} · persistence ${db.persistence.actual}${
            db.persistence.reason ? ` (${db.persistence.reason})` : ""
          } · loads ${loads}`}
      </p>
      <p
        data-testid="r6-notifications"
        style={{ margin: 0, color: "#555", fontSize: 12 }}
      >
        {`change notifications ${notifications} · last change: ${lastChange}`}
      </p>
      <div style={styles.controls}>
        <button
          type="button"
          data-testid="r6-reset"
          disabled={!app}
          onClick={onReset}
        >
          Reset to seed
        </button>
        {dbView.phase === "ready"
          ? (
            <button
              type="button"
              data-testid="r6-db-toggle"
              onClick={() => setDbView({ ...dbView, visible: !dbView.visible })}
            >
              {dbView.visible ? "Hide database view" : "Show database view"}
            </button>
          )
          : (
            <button
              type="button"
              data-testid="r6-db-toggle"
              disabled={!app || dbView.phase === "starting"}
              onClick={openView}
            >
              {dbView.phase === "starting"
                ? "Starting database view…"
                : "Open database view"}
            </button>
          )}
      </div>
      {message && (
        <p role="alert" data-testid="r6-error" style={styles.error}>
          {message}
        </p>
      )}
      {dbView.phase === "failed" && (
        <p role="alert" data-testid="r6-db-error" style={styles.error}>
          {`Database view unavailable: ${dbView.message}`}
        </p>
      )}
      {overview && (
        // A failed reload keeps the last good numbers, marked as stale.
        <div
          data-testid="r6-overview"
          data-stale={message ? "true" : "false"}
          style={message ? { opacity: 0.45 } : undefined}
        >
          {message && (
            <p style={{ margin: "8px 0 0", fontSize: 12 }}>
              Showing the last successful load (stale).
            </p>
          )}
          <OverviewView overview={overview} />
        </div>
      )}
      {dbView.phase === "ready" && dbView.visible && (
        <div style={{ marginTop: 12 }}>
          <DatabaseEditor
            binding={dbView.binding}
            title="Event analytics database"
          />
        </div>
      )}
    </div>
  );
}

// ---- the playground block -------------------------------------------------------

/** `?r6=opfs` persists the analytics database in OPFS; memory otherwise. */
const persistenceFromUrl = (): Persistence =>
  new URLSearchParams(globalThis.location?.search ?? "").get("r6") === "opfs"
    ? "opfs"
    : "memory";

let starts = 0;
let disposals = 0;
const countStart = () => {
  starts++;
};
const countDisposal = () => {
  disposals++;
};
const playgroundLayer = () =>
  eventAnalyticsDuckDbLayer({ persistence: persistenceFromUrl() });

/**
 * Playground mount for R6: closed by default (nothing DuckDB-related loads);
 * "Open event analytics" mounts one instance, "Close" unmounts it.
 */
export function EventAnalyticsWorkbench() {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const instance = useRef<EventAnalyticsInstanceHooks | undefined>(undefined);
  const onHooks = useCallback(
    (hooks: EventAnalyticsInstanceHooks | undefined) => {
      instance.current = hooks;
    },
    [],
  );

  useEffect(() => {
    const hooks: EventAnalyticsHooks = {
      open: () => setOpen(true),
      close: () => setOpen(false),
      isOpen: () => openRef.current,
      instance: () => instance.current,
      starts: () => starts,
      disposals: () => disposals,
    };
    const target = globalThis as { __playground?: Record<string, unknown> };
    // The playground creates `__playground` in its own effect, after this
    // child's: attach once it exists.
    const attach = () => {
      if (!target.__playground) return false;
      target.__playground.r6 = hooks;
      return true;
    };
    // Bounded: a page without the playground's hooks object stops trying
    // after ~10 s.
    let tries = 0;
    const timer = attach() ? undefined : setInterval(() => {
      if (attach() || ++tries > 500) clearInterval(timer);
    }, 20);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      if (target.__playground?.r6 === hooks) delete target.__playground.r6;
    };
  }, []);

  return (
    <section data-testid="r6-workbench" style={{ ...box, marginTop: 16 }}>
      <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>
        Event analytics (DuckDB) {open
          ? (
            <button
              type="button"
              data-testid="r6-close"
              onClick={() => setOpen(false)}
            >
              Close event analytics
            </button>
          )
          : (
            <button
              type="button"
              data-testid="r6-open"
              onClick={() => setOpen(true)}
            >
              Open event analytics
            </button>
          )}
      </h2>
      {!open && (
        <p data-testid="r6-closed" style={{ margin: 0, color: "#555" }}>
          DuckDB not loaded
        </p>
      )}
      {open && (
        <EventAnalyticsApp
          layer={playgroundLayer}
          onHooks={onHooks}
          onStarted={countStart}
          onDisposed={countDisposal}
        />
      )}
    </section>
  );
}
