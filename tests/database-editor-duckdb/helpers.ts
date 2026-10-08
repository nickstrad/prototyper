// Shared helpers for the DB1 suite: the upstream DuckDB web shell embedded in
// DB0's DatabaseEditor host on D2's service, mounted by the playground's DB1
// block (`window.__playground.db1`). Lines typed into the console go through
// real keystrokes (page.keyboard) so the shell sees what a user types;
// evidence files hold the shell's real terminal buffer.
import { type CDPSession, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import type { Db1Hooks } from "../../packages/database-editor/duckdb-shell.ts";

export const target = process.env.PW_TARGET ?? "dev";
export const outDir = process.env.PW_OUT ?? "test-results";
export const evidenceDir = `${outDir}/db1-evidence`;

export const PROMPT = "duckdb> ";
export const CONTINUATION = "   ...> ";
/** D2's refusal (packages/database/duckdb-engine.ts OPEN_BLOCKED). */
export const OPEN_REFUSAL =
  "AsyncDuckDB.open is blocked: the database path is fixed by the DatabaseService (plan.md Q12/Q17/Q18)";

type PlaygroundWindow = { __playground?: { db1?: Db1Hooks } };

/** Runs `f` against the DB1 hooks inside the page. */
export const db1 = <A, R>(
  page: Page,
  f: (hooks: Db1Hooks, arg: A) => R | Promise<R>,
  arg: A,
): Promise<R> =>
  page.evaluate(
    async ([source, a]) => {
      const hooks = (globalThis as PlaygroundWindow).__playground!.db1!;
      // deno-lint-ignore no-explicit-any
      const fn = (0, eval)(source) as (h: Db1Hooks, a: any) => R;
      return await fn(hooks, a);
    },
    [f.toString(), arg] as const,
  );

export function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const text = m.text();
    // Chromium's own GPU notes; the shell renders with xterm's DOM renderer.
    if (text.includes("GL Driver Message")) return;
    // The shell's wasm-bindgen glue (upstream) calls init(module) this way.
    if (text.includes("using deprecated parameters for the initialization")) {
      return;
    }
    problems.push(`${m.type()}: ${text}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e)}`));
  return problems;
}

/** Loads the playground and waits for the (still closed) DB1 hooks. */
export async function loadPlayground(page: Page) {
  await page.goto("/");
  await loadPlaygroundHooks(page);
}

/** Waits for the current instance generation's (still closed) DB1 hooks. */
export async function loadPlaygroundHooks(page: Page) {
  await expect.poll(
    () =>
      page.evaluate(() =>
        Boolean((globalThis as PlaygroundWindow).__playground?.db1)
      ),
    { timeout: 30_000 },
  ).toBe(true);
}

/** Clicks "Open", waits for the engine, the embedded shell and its prompt. */
export async function openInstance(page: Page) {
  await page.getByTestId("db1-open").click();
  await expect(page.getByTestId("db1-status")).toContainText("engine ready", {
    timeout: 90_000,
  });
  await expect(page.getByTestId("duckdb-shell").locator(".xterm"))
    .toBeVisible({ timeout: 60_000 });
  await expect.poll(() => screen(page), { timeout: 60_000 }).toMatch(
    /duckdb> $/,
  );
  await idle(page);
}

export async function openDuckDb(page: Page) {
  await loadPlayground(page);
  await openInstance(page);
  await focusShell(page);
}

export const focusShell = (page: Page) =>
  page.getByTestId("duckdb-shell").locator(".xterm").click();

export const screen = (page: Page) => db1(page, (h) => h.screen(), null);

export const idle = (page: Page) => db1(page, (h) => h.idle(), null);

const prompts = (page: Page) =>
  db1(page, (h) => h.runtime?.binding.prompts ?? 0, null);

/**
 * Types one line, presses Enter and waits for the shell's next prompt (main
 * or continuation) and for change reporting to settle. The shell drops keys
 * typed while a statement runs, so callers never type ahead.
 */
export async function typeLine(page: Page, line: string) {
  const before = await prompts(page);
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
  await expect.poll(() => prompts(page), { timeout: 30_000 })
    .toBeGreaterThan(before);
  await idle(page);
}

/**
 * Terminal text after the last line the user typed that ends with `marker`
 * (a line starting with the main or continuation prompt).
 */
export const after = (text: string, marker: string) => {
  let i = text.lastIndexOf(marker);
  while (i >= 0) {
    const lineStart = text.lastIndexOf("\n", i - 1) + 1;
    const line = text.slice(lineStart, i + marker.length);
    if (line.startsWith(PROMPT) || line.startsWith(CONTINUATION)) {
      return text.slice(i + marker.length);
    }
    i = i > 0 ? text.lastIndexOf(marker, i - 1) : -1;
  }
  return "";
};

/** The output of the last submission of `line`, up to the next prompt. */
export const outputOf = (text: string, line: string) => {
  const rest = after(text, `${PROMPT}${line}\n`);
  const end = rest.indexOf(`\n${PROMPT}`);
  return end < 0 ? rest : rest.slice(0, end);
};

export function saveEvidence(name: string, content: string) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/${name}`, content);
}

/**
 * Screenshot of the DB1 section. It is scrolled into view first and given a
 * moment: xterm pauses rendering while its element is off screen, so a
 * full-page capture of an off-screen console shows stale rows.
 */
export async function screenshot(page: Page, name: string) {
  const section = page.getByTestId("db1-workbench");
  await section.scrollIntoViewIfNeeded();
  await page.getByTestId("duckdb-shell").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await section.screenshot({ path: `${evidenceDir}/${name}-${target}.png` });
}

/** Live window and document listener types, from DevTools (not counters). */
export async function liveListeners(cdp: CDPSession) {
  const out: Record<string, string[]> = {};
  for (const expression of ["window", "document"]) {
    const { result } = await cdp.send("Runtime.evaluate", { expression });
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
      objectId: result.objectId!,
    });
    out[expression] = listeners.map((l) => l.type).sort();
  }
  return out;
}

/** The upstream shell's code: its package in dev, its chunk in the build. */
const SHELL_SCRIPT = /duckdb-wasm-shell|\/assets\/shell-[\w-]+\.js/;

/**
 * Window/document listeners whose handler lives in the upstream shell's
 * script (DevTools `scriptId` → URL), so other playground terminals cannot
 * blur the count. Call `trackScripts` before navigating.
 */
export async function trackScripts(cdp: CDPSession) {
  const urls = new Map<string, string>();
  cdp.on("Debugger.scriptParsed", (e) => urls.set(e.scriptId, e.url));
  await cdp.send("Debugger.enable");
  return async () => {
    const out: string[] = [];
    for (const expression of ["window", "document"]) {
      const { result } = await cdp.send("Runtime.evaluate", { expression });
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
        objectId: result.objectId!,
      });
      for (const l of listeners) {
        if (SHELL_SCRIPT.test(urls.get(l.scriptId) ?? "")) {
          out.push(`${expression}:${l.type}`);
        }
      }
    }
    return out.sort();
  };
}

/**
 * Live listeners once the page is quiet: two snapshots a second apart agree
 * (the playground's other terminals settle their own listeners after load).
 */
export async function settledListeners(cdp: CDPSession, page: Page) {
  let last = JSON.stringify(await liveListeners(cdp));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const now = JSON.stringify(await liveListeners(cdp));
    if (now === last) return JSON.parse(now) as Record<string, string[]>;
    last = now;
  }
  throw new Error(`window/document listeners never settled: ${last}`);
}

/** All JS event listeners in the page after a forced GC (DevTools metric). */
export async function jsListenerCount(cdp: CDPSession) {
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((m) => m.name === "JSEventListeners")?.value ?? -1;
}

/** Live DuckDB engine workers (the playground also runs Fiddle workers). */
export const duckDbWorkers = (page: Page) =>
  page.workers().filter((w) => w.url().includes("duckdb")).length;
