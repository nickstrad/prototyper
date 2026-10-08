// Shared Playwright helpers for driving the embedded upstream DuckDB shell.
import { chromium } from "playwright";

export const BASE = process.env.BASE ?? "http://localhost:5181/";

export async function launch() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1300 } });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  return { browser, context, page, logs };
}

export async function open(page, query = "") {
  await page.goto(BASE + query);
  await page.waitForFunction(() => window.pocReady || window.pocError, null, { timeout: 120000 });
  const err = await page.evaluate(() => window.pocError);
  if (err) throw new Error(err);
}

export const text = (page, i = 0) => page.evaluate((i) => window.poc.termText(i), i);

export async function settle(page, i = 0, quietMs = 600, maxMs = 20000) {
  let last = await text(page, i), since = Date.now(), start = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(100);
    const now = await text(page, i);
    if (now !== last) { last = now; since = Date.now(); }
    else if (Date.now() - since > quietMs) break;
  }
  return last;
}

/** Type `input` (may contain \n for Enter) into terminal i; return the new terminal text. */
export async function run(page, input, i = 0) {
  await page.evaluate((i) => window.poc.termFocus(i), i);
  const before = await settle(page, i, 300);
  const parts = input.split("\n");
  for (let k = 0; k < parts.length; k++) {
    if (parts[k]) await page.keyboard.type(parts[k], { delay: 5 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(80);
    // The shell does not buffer keystrokes typed while a statement runs (observed
    // lost input), so wait for output to settle after each complete statement/command.
    const t = parts[k].trim();
    if (t.endsWith(";") || t.startsWith(".")) await waitPrompt(page, i);
  }
  const after = await settle(page, i);
  // Return the suffix that changed: start at the last line of `before` (the prompt line).
  const bl = before.split("\n"), al = after.split("\n");
  return al.slice(Math.max(0, bl.length - 1)).join("\n");
}

/** Wait until the terminal's last line is a fresh, empty `duckdb> ` prompt and output is quiet. */
export async function waitPrompt(page, i = 0, maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const t = await settle(page, i, 300);
    if (t.split("\n").pop() === "duckdb> ") return t;
  }
  return text(page, i);
}
