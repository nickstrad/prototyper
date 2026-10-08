// Shared helpers for the R6 browser specs: the event analytics prototype
// mounted by the playground's R6 block (`window.__playground.r6`) on D2's
// DuckDB service, with DB0's DatabaseEditor and DB1's upstream shell in its
// Database view. Lines typed into the shell go through real keystrokes.
// Listener and worker counting follows tests/database-editor-duckdb/
// helpers.ts (DevTools listener lists, page.workers()).
import { type CDPSession, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";
import type {
  EventAnalyticsHooks,
  EventAnalyticsInstanceHooks,
} from "../../prototypes/event-analytics/App.tsx";
import type { ExpectedOverview } from "./oracle.ts";

export const target = process.env.PW_TARGET ?? "dev";
export const outDir = process.env.PW_OUT ?? "test-results";
export const evidenceDir = `${outDir}/r6-evidence`;

export const PROMPT = "duckdb> ";

type PlaygroundWindow = {
  __playground?: {
    r6?: EventAnalyticsHooks;
    db1?: { dispose(): Promise<void>; open(): Promise<void> };
  };
};

/** Runs `f` against the open analytics instance's hooks inside the page. */
export const inst = <A, R>(
  page: Page,
  f: (hooks: EventAnalyticsInstanceHooks, arg: A) => R | Promise<R>,
  arg: A,
): Promise<R> =>
  page.evaluate(
    async ([source, a]) => {
      const hooks = (globalThis as PlaygroundWindow).__playground!.r6!
        .instance();
      if (!hooks) throw new Error("the event analytics is not open");
      const fn = (0, eval)(source) as (
        h: EventAnalyticsInstanceHooks,
        a: unknown,
      ) => R;
      return await fn(hooks, a);
    },
    [f.toString(), arg] as const,
  );

export const starts = (page: Page) =>
  page.evaluate(() =>
    (globalThis as PlaygroundWindow).__playground!.r6!.starts()
  );

export const disposals = (page: Page) =>
  page.evaluate(() =>
    (globalThis as PlaygroundWindow).__playground!.r6!.disposals()
  );

export function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const text = m.text();
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

/** Waits for the current instance's (closed) R6 hooks. */
export async function loadHooks(page: Page) {
  await expect.poll(
    () =>
      page.evaluate(() =>
        Boolean((globalThis as PlaygroundWindow).__playground?.r6)
      ),
    { timeout: 30_000 },
  ).toBe(true);
}

/**
 * Loads the playground. Q18: the DuckDB web shell is a page singleton, and
 * the playground also hosts DB1's workbench; release it before R6 opens its
 * Database view (a no-op when DB1 was never opened).
 */
export async function loadPlayground(page: Page) {
  await page.goto("/");
  await loadHooks(page);
  await instanceReady(page);
  await releaseDb1(page);
}

/**
 * Waits until the rest of the playground instance has finished mounting
 * (R1's task list loaded; DB0's own-engine editor and R4's shared-engine
 * editor with their consoles open, or given up). Every open xterm 6 terminal
 * holds one window "resize" listener (its devicePixelRatio monitor) and
 * these consoles open after their engines start, so listener baselines are
 * taken only after this.
 */
export async function instanceReady(page: Page) {
  await expect(page.getByTestId("r1-status")).toContainText("loads", {
    timeout: 60_000,
  });
  // Settled states only: DB0 briefly shows "editor disposed (worker
  // terminated)" after a (StrictMode) mount before its engine is ready.
  const db0 = page.getByTestId("db0-status");
  await expect(db0).toHaveText(/engine ready|editor failed/, {
    timeout: 60_000,
  });
  if ((await db0.textContent())?.includes("engine ready")) {
    await expect(
      page.locator("section", { has: db0 }).locator(".xterm"),
    ).toHaveCount(1, { timeout: 60_000 });
  }
  const r4 = page.getByTestId("r4-editor-status");
  await expect(r4).not.toHaveText(/waiting|^$/, { timeout: 60_000 });
  if ((await r4.textContent())?.includes("bound")) {
    await expect(page.getByTestId("r4-editor").locator(".xterm"))
      .toHaveCount(1, { timeout: 60_000 });
  }
}

export const releaseDb1 = (page: Page) =>
  page.evaluate(() =>
    (globalThis as PlaygroundWindow).__playground?.db1?.dispose()
  );

export const section = (page: Page) => page.getByTestId("r6-workbench");

/** Clicks "Open event analytics" and waits for the first rendered load. */
export async function openAnalytics(page: Page) {
  await section(page).getByTestId("r6-open").click();
  await expect(section(page).getByTestId("r6-status")).toContainText(
    "loads 1",
    { timeout: 90_000 },
  );
  await expect.poll(
    () =>
      page.evaluate(() =>
        Boolean((globalThis as PlaygroundWindow).__playground?.r6?.instance())
      ),
  ).toBe(true);
}

export const shellElement = (page: Page) =>
  section(page).getByTestId("duckdb-shell");

/** Opens (or shows) the Database view and waits for the shell's prompt. */
export async function openDatabaseView(page: Page) {
  await section(page).getByTestId("r6-db-toggle").click();
  await expect(shellElement(page).locator(".xterm")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => screen(page), { timeout: 60_000 }).toMatch(
    /duckdb> $/,
  );
  await idle(page);
  await focusShell(page);
}

export const focusShell = (page: Page) =>
  shellElement(page).locator(".xterm").click();

export const screen = (page: Page) => inst(page, (h) => h.screen(), null);
export const idle = (page: Page) => inst(page, (h) => h.idle(), null);
const prompts = (page: Page) =>
  inst(page, (h) => h.binding()?.prompts ?? 0, null);

/**
 * Types one line into the shell (focused first: a host button may hold the
 * focus) and waits for the next prompt and settled change reporting.
 */
export async function typeLine(page: Page, line: string) {
  await inst(page, (h) => h.binding()?.focus(), null);
  const before = await prompts(page);
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
  await expect.poll(() => prompts(page), { timeout: 30_000 })
    .toBeGreaterThan(before);
  await idle(page);
}

/**
 * The output of the last submission: the text between the last two main
 * prompts (the shell echoes long input over several rows, so the typed text
 * itself is not a reliable marker), minus the echoed input.
 */
export const lastOutput = (text: string) => {
  const end = text.lastIndexOf(`\n${PROMPT}`);
  const start = text.lastIndexOf(`\n${PROMPT}`, end - 1);
  return start < 0 || end < 0 ? "" : text.slice(start + 1, end);
};

/** Types `sql` (`;` added) and returns the shell's box table. */
export async function shellQuery(page: Page, sql: string) {
  const line = sql.endsWith(";") ? sql : `${sql};`;
  await typeLine(page, line);
  const out = lastOutput(await screen(page));
  return { text: out, ...parseBox(out) };
}

/** Parses the DuckDB shell's box table (`│ a ┆ b │` lines). */
export const parseBox = (text: string) => {
  const lines = text.split("\n").map((l) => l.trim())
    .filter((l) => l.startsWith("│") && l.endsWith("│"))
    .map((l) => l.slice(1, -1).split(/[│┆]/).map((c) => c.trim()));
  return { header: lines[0] ?? [], rows: lines.slice(1) };
};

/** The panel as rendered (DOM text), shaped like the oracle's overview. */
export async function readPanel(page: Page): Promise<ExpectedOverview> {
  const s = section(page);
  const num = async (id: string) =>
    Number(await s.getByTestId(id).textContent());
  const rows = async (id: string) =>
    await s.getByTestId(id).locator("tbody tr").evaluateAll((trs) =>
      trs.map((tr) =>
        [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")
      )
    );
  return {
    totals: {
      events: await num("r6-total-events"),
      views: await num("r6-total-views"),
      signups: await num("r6-total-signups"),
      revenue: (await s.getByTestId("r6-total-revenue").textContent()) ?? "",
    },
    perDay: (await rows("r6-per-day")).map(([day, views, signups]) => ({
      day,
      views: Number(views),
      signups: Number(signups),
    })),
    sources: (await rows("r6-sources")).map((
      [source, events, signups, revenue],
    ) => ({
      source,
      events: Number(events),
      signups: Number(signups),
      revenue,
    })),
    countries: (await rows("r6-countries")).map((
      [country, views, signups, pct],
    ) => ({
      country,
      views: Number(views),
      signups: Number(signups),
      conversionPct: pct === "–" ? null : pct,
    })),
  };
}

/** Notifications the panel counted, from its own status line. */
export async function panelNotifications(page: Page): Promise<number> {
  const text = await section(page).getByTestId("r6-notifications")
    .textContent();
  return Number(/change notifications (\d+)/.exec(text ?? "")?.[1] ?? NaN);
}

export function saveEvidence(name: string, content: string) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/${name}`, content);
}

/**
 * Screenshot of the R6 section, scrolled into view first (xterm pauses
 * rendering off screen). The viewport is made tall enough for the section:
 * a capture beyond the viewport resizes the page mid-capture.
 */
export async function screenshot(page: Page, name: string) {
  const s = section(page);
  const box = await s.boundingBox();
  const viewport = page.viewportSize();
  if (box && viewport && box.height + 40 > viewport.height) {
    await page.setViewportSize({
      width: viewport.width,
      height: Math.ceil(box.height + 40),
    });
  }
  await s.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  mkdirSync(evidenceDir, { recursive: true });
  await s.screenshot({ path: `${evidenceDir}/${name}-${target}.png` });
}

/** Live window and document listener types, from DevTools. */
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

/** Live listeners once two snapshots a second apart agree. */
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

/** The upstream shell's code: its package in dev, its chunk in the build. */
const SHELL_SCRIPT = /duckdb-wasm-shell|\/assets\/shell-[\w-]+\.js/;

/**
 * Window/document listeners whose handler lives in the shell's script
 * (`shell()`), and every listener with its script URL (`all()`, for logs).
 * Call before navigating.
 */
export async function trackShellListeners(cdp: CDPSession) {
  const urls = new Map<string, string>();
  cdp.on("Debugger.scriptParsed", (e) => urls.set(e.scriptId, e.url));
  await cdp.send("Debugger.enable");
  const all = async () => {
    const out: { key: string; url: string }[] = [];
    for (const expression of ["window", "document"]) {
      const { result } = await cdp.send("Runtime.evaluate", { expression });
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
        objectId: result.objectId!,
      });
      for (const l of listeners) {
        out.push({
          key: `${expression}:${l.type}`,
          url: urls.get(l.scriptId) ?? "?",
        });
      }
    }
    return out;
  };
  return {
    shell: async () =>
      (await all()).filter((l) => SHELL_SCRIPT.test(l.url)).map((l) => l.key)
        .sort(),
    all: async () =>
      (await all()).map((l) =>
        `${l.key} @ ${new URL(l.url, "http://x").pathname}`
      )
        .sort(),
  };
}

/** Live DuckDB engine workers (the playground also runs Fiddle workers). */
export const duckDbWorkers = (page: Page) =>
  page.workers().filter((w) => w.url().includes("duckdb")).length;

/** Requests only a DuckDB view may cause (engine, worker, shell). */
export const DUCKDB_ASSET =
  /shell_bg|duckdb-eh|duckdb-browser|duckdb-wasm|duckdb_duckdb|vendor\/duckdb|duckdb-(service|engine|cells)/;
