// Playground test hooks for the DuckDB DatabaseService (D2). This module has
// no DuckDB import: the engine, Arrow and the harness load only when a test
// (or a page) calls `window.__playground.d2.load()`, so pages that never use
// DuckDB fetch none of its assets.
import { useEffect } from "react";

/** `window.__playground.d2`: lazy entry point into duckdb-harness.ts. */
export type DuckDbPlaygroundHooks = {
  load(): Promise<typeof import("./duckdb-harness.ts")>;
};

const hooks: DuckDbPlaygroundHooks = {
  load: () => import("./duckdb-harness.ts"),
};

/**
 * Publishes the hooks as `window.__playground.d2`. The playground creates
 * `__playground` in its own effect, which runs after this child's (also on a
 * StrictMode remount, where both effects run again), so poll until it exists,
 * attach once, and stop.
 */
export function DuckDbHooks(): null {
  useEffect(() => {
    const target = globalThis as { __playground?: Record<string, unknown> };
    const attach = () => {
      if (!target.__playground) return false;
      target.__playground.d2 = hooks;
      return true;
    };
    if (attach()) return;
    const timer = setInterval(() => {
      if (attach()) clearInterval(timer);
    }, 20);
    return () => clearInterval(timer);
  }, []);
  return null;
}
