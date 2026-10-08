// Shared helpers for the D2 browser specs (Playwright, page-side harness).
import type { Page } from "@playwright/test";
import process from "node:process";
import type { DuckDbPlaygroundHooks } from "../../packages/database/duckdb-hooks.tsx";

export const target = process.env.PW_TARGET ?? "dev";

export type D2Window = { __playground?: { d2?: DuckDbPlaygroundHooks } };
export type Harness = Awaited<ReturnType<DuckDbPlaygroundHooks["load"]>>;

// duckdb-wasm warns once per file a statement writes that was not
// registered first (EXPORT DATABASE for exportBytes(), COPY ... TO).
const EXPECTED = /^Buffering missing file: /;

export function collectProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (
      (m.type() === "error" || m.type() === "warning") &&
      !EXPECTED.test(m.text())
    ) {
      problems.push(m.text());
    }
  });
  page.on("pageerror", (e) => problems.push(String(e)));
  return problems;
}

export async function ready(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() =>
    (globalThis as unknown as D2Window).__playground?.d2 !== undefined
  );
}

/** Runs `f(harness, arg)` in the page (f must not close over test scope). */
export function inPage<A, R>(
  page: Page,
  f: (h: Harness, arg: A) => Promise<R>,
  arg: A,
): Promise<R> {
  return page.evaluate(
    async ([source, a]) => {
      const h = await (globalThis as unknown as D2Window).__playground!.d2!
        .load();
      // deno-lint-ignore no-explicit-any
      return await (0, eval)(source)(h, a) as any;
    },
    [f.toString(), arg] as const,
  ) as Promise<R>;
}
